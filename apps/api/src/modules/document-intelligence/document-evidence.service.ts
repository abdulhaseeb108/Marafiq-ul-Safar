import mongoose, { type ClientSession } from 'mongoose';
import { SourceDocumentModel } from '../rate-sheets/rate-sheet.models.js';
import { DocumentProcessingJobModel } from './document-processing.models.js';
import {
  DOCUMENT_EVIDENCE_KINDS,
  DocumentEvidenceModel,
  type DocumentEvidenceDoc,
} from './document-evidence.models.js';
import type { ProcessingExecutionContext } from './document-processing.execution.js';

export interface DocumentEvidenceInput {
  kind: (typeof DOCUMENT_EVIDENCE_KINDS)[number];
  location: {
    page?: number;
    sheet?: string;
    row?: number;
    column?: number;
    cell?: string;
    segment?: number;
  };
  content: unknown;
  metadata?: unknown;
}

export class DocumentEvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentEvidenceIntegrityError';
  }
}

function parseObjectId(value: string): mongoose.Types.ObjectId {
  if (!mongoose.isValidObjectId(value)) throw new TypeError('Invalid source document id.');
  return new mongoose.Types.ObjectId(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceIdentity(evidence: DocumentEvidenceInput): string {
  return stableJson([evidence.kind, evidence.location]);
}

function sameEvidence(existing: DocumentEvidenceDoc, input: DocumentEvidenceInput): boolean {
  return (
    existing.kind === input.kind &&
    stableJson(existing.toObject().location) === stableJson(input.location) &&
    stableJson(existing.content) === stableJson(input.content) &&
    stableJson(existing.metadata ?? null) === stableJson(input.metadata ?? null)
  );
}

async function writeInTransaction(
  session: ClientSession,
  context: ProcessingExecutionContext,
  sourceDocumentId: mongoose.Types.ObjectId,
  input: DocumentEvidenceInput,
  evidenceKey: string,
): Promise<DocumentEvidenceDoc> {
  const sourceDocument = await SourceDocumentModel.findById(sourceDocumentId)
    .select('_id')
    .session(session)
    .lean();
  const job = await DocumentProcessingJobModel.findOne({
    _id: new mongoose.Types.ObjectId(context.jobId),
    sourceDocumentId,
    status: 'parsing',
    malwareScanStatus: 'clean',
    activeRunId: context.runId,
    'lease.token': context.leaseToken,
    'lease.expiresAt': { $gt: new Date() },
  })
    .select('_id')
    .session(session)
    .lean();
  if (!sourceDocument) throw new DocumentEvidenceIntegrityError('Source document does not exist.');
  if (!job) {
    throw new DocumentEvidenceIntegrityError(
      'Evidence requires a clean scan and the current parsing lease for its source document.',
    );
  }

  const fields = {
    sourceDocumentId,
    processingJobId: new mongoose.Types.ObjectId(context.jobId),
    evidenceKey,
    kind: input.kind,
    location: input.location,
    content: input.content,
    metadata: input.metadata,
    reviewStatus: 'unreviewed' as const,
  };
  const existing = await DocumentEvidenceModel.findOneAndUpdate(
    { processingJobId: fields.processingJobId, evidenceKey },
    { $setOnInsert: fields },
    {
      upsert: true,
      returnDocument: 'after',
      session,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
  if (!existing) throw new Error('Evidence upsert did not return a document.');
  if (!sameEvidence(existing, input)) {
    throw new DocumentEvidenceIntegrityError(
      'The stable evidence identity already exists with different extracted content.',
    );
  }
  return existing;
}

/** Persists bounded, immutable, unreviewed evidence only for a live clean-scan parsing run. */
export async function persistDocumentEvidence(
  context: ProcessingExecutionContext,
  sourceDocumentId: string,
  input: DocumentEvidenceInput,
): Promise<DocumentEvidenceDoc> {
  context.assertActive();
  const sourceId = parseObjectId(sourceDocumentId);
  if (!DOCUMENT_EVIDENCE_KINDS.includes(input.kind)) {
    throw new TypeError('Unsupported document evidence kind.');
  }

  const sourceKey = sourceIdentity(input);
  const evidenceKey = context.evidenceIdempotencyKey(sourceKey);
  const draft = new DocumentEvidenceModel({
    sourceDocumentId: sourceId,
    processingJobId: new mongoose.Types.ObjectId(context.jobId),
    evidenceKey,
    kind: input.kind,
    location: input.location,
    content: input.content,
    metadata: input.metadata,
  });
  await draft.validate();

  return context.writeEvidence(sourceKey, (_key, _signal, session) =>
    writeInTransaction(session, context, sourceId, input, evidenceKey),
  );
}
