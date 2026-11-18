import { createHash } from 'node:crypto';
import mongoose, { type ClientSession } from 'mongoose';
import { DocumentProcessingJobModel } from './document-processing.models.js';

export class ProcessingLeaseLostError extends Error {
  constructor() {
    super('Document processing was cancelled because its lease was lost.');
    this.name = 'ProcessingLeaseLostError';
  }
}

export interface ProcessingExecutionContext {
  readonly jobId: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly pipelineVersion: string;
  readonly signal: AbortSignal;
  assertActive(): void;
  stopRenewal(options?: { abortWork?: boolean }): Promise<void>;
  evidenceIdempotencyKey(sourceIdentity: string): string;
  writeEvidence<T>(
    sourceIdentity: string,
    write: (idempotencyKey: string, signal: AbortSignal, session: ClientSession) => Promise<T>,
  ): Promise<T>;
}

export interface ProcessingExecutionOptions {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs?: number;
}

export interface ProcessingExecutionLease {
  jobId: string;
  runId: string;
  leaseToken: string;
  pipelineVersion: string;
}

function assertDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer.`);
}

function evidenceKey(jobId: string, pipelineVersion: string, sourceIdentity: string): string {
  if (!sourceIdentity.trim()) throw new TypeError('Evidence source identity is required.');
  const digest = createHash('sha256')
    .update(JSON.stringify([jobId, pipelineVersion, sourceIdentity]))
    .digest('hex');
  return `document-evidence:${digest}`;
}

/**
 * Runs one claimed job with lease renewal and cancellation.
 *
 * Processing is at-least-once: a crash can happen after an external side
 * effect succeeds but before job completion is recorded. Every external side
 * effect must therefore use an idempotency key. Evidence keys are stable
 * across retries for the same job, pipeline version, and source identity.
 * Evidence writers must perform MongoDB writes with the supplied session.
 * The lease check and evidence write commit in one transaction. Transaction
 * callbacks may be retried, so they must not perform non-idempotent external
 * side effects.
 */
export async function runWithProcessingLease<T>(
  lease: ProcessingExecutionLease,
  options: ProcessingExecutionOptions,
  work: (context: ProcessingExecutionContext) => Promise<T>,
): Promise<T> {
  assertDuration(options.leaseDurationMs, 'leaseDurationMs');
  assertDuration(options.heartbeatIntervalMs, 'heartbeatIntervalMs');
  if (options.heartbeatIntervalMs >= options.leaseDurationMs)
    throw new RangeError('heartbeatIntervalMs must be shorter than leaseDurationMs.');
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ??
    Math.floor((options.leaseDurationMs - options.heartbeatIntervalMs) / 2);
  assertDuration(heartbeatTimeoutMs, 'heartbeatTimeoutMs');
  if (options.heartbeatIntervalMs + heartbeatTimeoutMs >= options.leaseDurationMs)
    throw new RangeError('heartbeat timeout and interval must fit within the lease duration.');

  const controller = new AbortController();
  let rejectLost!: (error: ProcessingLeaseLostError) => void;
  const leaseLost = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  void leaseLost.catch(() => undefined);
  let lost = false;
  let stopped = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const activeSessions = new Set<ClientSession>();
  const activeEvidenceWrites = new Set<Promise<unknown>>();
  let stopHeartbeatResolve!: () => void;
  const heartbeatStopped = new Promise<void>((resolve) => {
    stopHeartbeatResolve = resolve;
  });

  const loseLease = (): ProcessingLeaseLostError => {
    if (!lost) {
      lost = true;
      controller.abort();
      rejectLost(new ProcessingLeaseLostError());
      for (const session of activeSessions) {
        void session.abortTransaction().catch(() => undefined);
      }
    }
    return new ProcessingLeaseLostError();
  };

  const renew = async (): Promise<void> => {
    if (lost || stopped) throw new ProcessingLeaseLostError();
    try {
      const now = new Date();
      const update = Promise.resolve(
        DocumentProcessingJobModel.updateOne(
          {
            _id: new mongoose.Types.ObjectId(lease.jobId),
            activeRunId: lease.runId,
            status: { $in: ['scanning', 'parsing'] },
            'lease.token': lease.leaseToken,
            'lease.expiresAt': { $gt: now },
          },
          {
            $set: {
              'lease.heartbeatAt': now,
              'lease.expiresAt': new Date(now.getTime() + options.leaseDurationMs),
            },
          },
          { maxTimeMS: heartbeatTimeoutMs },
        ),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Document processing lease heartbeat timed out.')),
          heartbeatTimeoutMs,
        );
      });
      let result: Awaited<typeof update>;
      try {
        result = await Promise.race([update, timedOut]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (result.matchedCount !== 1) throw loseLease();
    } catch (error) {
      if (error instanceof ProcessingLeaseLostError) throw error;
      throw loseLease();
    }
  };

  const stopRenewal = async (stopOptions: { abortWork?: boolean } = {}): Promise<void> => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
      stopHeartbeatResolve();
    }
    if (stopOptions.abortWork) {
      controller.abort();
      for (const session of activeSessions) {
        await session.abortTransaction().catch(() => undefined);
      }
    }
    await heartbeatStopped;
    await heartbeatInFlight;
    if (!lost && !stopOptions.abortWork) {
      await Promise.all([...activeEvidenceWrites]);
    }
    if (lost) throw new ProcessingLeaseLostError();
  };

  const timer = setInterval(() => {
    if (stopped || lost || heartbeatInFlight || activeEvidenceWrites.size > 0) return;
    heartbeatInFlight = renew()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, options.heartbeatIntervalMs);

  const context: ProcessingExecutionContext = {
    jobId: lease.jobId,
    runId: lease.runId,
    leaseToken: lease.leaseToken,
    pipelineVersion: lease.pipelineVersion,
    signal: controller.signal,
    assertActive() {
      if (lost || controller.signal.aborted) throw new ProcessingLeaseLostError();
    },
    stopRenewal,
    evidenceIdempotencyKey(sourceIdentity) {
      return evidenceKey(lease.jobId, lease.pipelineVersion, sourceIdentity);
    },
    writeEvidence<T>(
      sourceIdentity: string,
      write: (idempotencyKey: string, signal: AbortSignal, session: ClientSession) => Promise<T>,
    ): Promise<T> {
      const pending: Promise<T> = (async () => {
        context.assertActive();
        await renew();
        context.assertActive();
        await heartbeatInFlight;
        context.assertActive();
        const session = await mongoose.startSession();
        activeSessions.add(session);
        try {
          let value!: T;
          const transaction = session.withTransaction(async () => {
            context.assertActive();
            const now = new Date();
            const ownership = await DocumentProcessingJobModel.updateOne(
              {
                _id: new mongoose.Types.ObjectId(lease.jobId),
                activeRunId: lease.runId,
                status: 'parsing',
                malwareScanStatus: 'clean',
                'lease.token': lease.leaseToken,
                'lease.expiresAt': { $gt: now },
              },
              {
                $set: {
                  'lease.heartbeatAt': now,
                  'lease.expiresAt': new Date(now.getTime() + options.leaseDurationMs),
                },
              },
              { session },
            );
            if (ownership.matchedCount !== 1) throw loseLease();
            value = (await write(
              context.evidenceIdempotencyKey(sourceIdentity),
              context.signal,
              session,
            )) as T;
            context.assertActive();
          });
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const transactionTimeout = new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(loseLease()),
              options.leaseDurationMs - options.heartbeatIntervalMs,
            );
          });
          try {
            await Promise.race([transaction, transactionTimeout]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
          context.assertActive();
          return value;
        } catch (error) {
          if (controller.signal.aborted) throw new ProcessingLeaseLostError();
          throw error;
        } finally {
          activeSessions.delete(session);
          await session.endSession();
        }
      })();
      activeEvidenceWrites.add(pending);
      void pending.finally(() => activeEvidenceWrites.delete(pending)).catch(() => undefined);
      return pending;
    },
  };

  let completed = false;
  try {
    await renew();
    const result = await Promise.race([work(context), leaseLost]);
    await stopRenewal();
    completed = true;
    return result;
  } finally {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
      stopHeartbeatResolve();
    }
    if (lost || !completed) {
      if (!lost) controller.abort();
      for (const session of activeSessions) {
        await session.abortTransaction().catch(() => undefined);
      }
    }
    await heartbeatStopped;
    await heartbeatInFlight;
  }
}
