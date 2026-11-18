import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '../../adapters/storage/storage.js';
import {
  UnavailableMalwareScanner,
  type MalwareScanner,
} from '../../adapters/malware-scanning/scanner.js';
import { SourceDocumentModel } from '../rate-sheets/rate-sheet.models.js';
import {
  failClaimedDocumentJob,
  claimNextDocumentJob,
  processClaimedDocumentJob,
  recoverExpiredDocumentJobs,
} from './document-processing.queue.js';
import type { DocumentParserLimits } from './document-parser-limits.js';
import { persistDocumentEvidence } from './document-evidence.service.js';
import { parseSupplierDocument } from './document-parsers.js';
import { errorName, log } from '../../lib/logger.js';

const LEASE_DURATION_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SCAN_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;

export interface DocumentProcessingWorkerTiming {
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  scanTimeoutMs: number;
  retryDelayMs: number;
  pollIntervalMs: number;
}

export interface DocumentProcessingWorkerOptions {
  storage: StorageAdapter;
  limits: DocumentParserLimits;
  scanner?: MalwareScanner;
  workerId?: string;
  timing?: Partial<DocumentProcessingWorkerTiming>;
}

export interface DocumentProcessingWorker {
  stop(): Promise<void>;
}

async function processOne(
  job: Awaited<ReturnType<typeof claimNextDocumentJob>> & {},
  options: DocumentProcessingWorkerOptions,
  scanner: MalwareScanner,
  timing: DocumentProcessingWorkerTiming,
): Promise<void> {
  const document = await SourceDocumentModel.findOne({
    _id: job.sourceDocumentId,
    intakePipeline: 'document-intelligence',
  }).select('_id fileKey fileName mimeType');
  if (!document) {
    await failClaimedDocumentJob(
      job._id,
      job.lease?.token ?? '',
      {
        stage: 'scan',
        code: 'source_document_missing',
        message: 'The source document record is missing.',
      },
      { retryDelayMs: timing.retryDelayMs },
    );
    return;
  }

  const data = await options.storage.get(document.fileKey);
  await processClaimedDocumentJob(
    job._id,
    job.lease?.token ?? '',
    scanner,
    { data, fileName: document.fileName, mimeType: document.mimeType },
    {
      scanTimeoutMs: timing.scanTimeoutMs,
      leaseDurationMs: timing.leaseDurationMs,
      heartbeatIntervalMs: timing.heartbeatIntervalMs,
      retryDelayMs: timing.retryDelayMs,
    },
    async (context) => {
      const parsed = await parseSupplierDocument(data, document.mimeType, options.limits);
      context.assertActive();
      for (const evidence of parsed.evidence) {
        await persistDocumentEvidence(context, document.id, evidence);
      }
      return { status: parsed.status, value: undefined, warnings: parsed.warnings };
    },
  );
}

/** Runs a single durable queue consumer; all parser calls pass through the scan gate. */
export function startDocumentProcessingWorker(
  options: DocumentProcessingWorkerOptions,
): DocumentProcessingWorker {
  const workerId = options.workerId ?? `document-worker:${randomUUID()}`;
  const scanner = options.scanner ?? new UnavailableMalwareScanner();
  const timing: DocumentProcessingWorkerTiming = {
    leaseDurationMs: LEASE_DURATION_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    scanTimeoutMs: SCAN_TIMEOUT_MS,
    retryDelayMs: RETRY_DELAY_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    ...options.timing,
  };
  for (const [name, value] of Object.entries(timing)) {
    const minimum = name === 'retryDelayMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  if (timing.heartbeatIntervalMs >= timing.leaseDurationMs) {
    throw new RangeError('heartbeatIntervalMs must be shorter than leaseDurationMs.');
  }
  let stopping = false;
  let wakeDelay: (() => void) | undefined;

  const wait = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeDelay = undefined;
        resolve();
      }, timing.pollIntervalMs);
      wakeDelay = () => {
        clearTimeout(timer);
        wakeDelay = undefined;
        resolve();
      };
    });

  const loop = async () => {
    while (!stopping) {
      try {
        await recoverExpiredDocumentJobs({
          batchSize: 100,
          retryDelayMs: timing.retryDelayMs,
        });
        const job = await claimNextDocumentJob(workerId, {
          leaseDurationMs: timing.leaseDurationMs,
        });
        if (job) {
          try {
            await processOne(job, options, scanner, timing);
          } catch (error) {
            if (error instanceof Error && error.name === 'JobLeaseLostError') continue;
            log.error('Document processing attempt failed', { error: errorName(error) });
          }
          continue;
        }
      } catch (error) {
        log.error('Document processing worker iteration failed', { error: errorName(error) });
      }
      if (!stopping) await wait();
    }
  };

  const running = loop();
  return {
    async stop() {
      stopping = true;
      wakeDelay?.();
      await running;
    },
  };
}
