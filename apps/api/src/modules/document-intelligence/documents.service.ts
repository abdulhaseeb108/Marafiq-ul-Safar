import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import mongoose from 'mongoose';
import type { StorageAdapter } from '../../adapters/storage/storage.js';
import { sourceDocumentKey } from '../../adapters/storage/storage.js';
import type { Actor } from '../audit/audit.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { HttpError, notFound } from '../../lib/http-error.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { SourceDocumentModel, type SourceDocumentDoc } from '../rate-sheets/rate-sheet.models.js';
import type { DocumentIntelligenceMimeType } from './document-formats.js';
import {
  DocumentProcessingJobModel,
  type DocumentProcessingJobDoc,
} from './document-processing.models.js';
import { enqueueDocumentJob } from './document-processing.queue.js';
import type { DocumentParserLimits } from './document-parser-limits.js';
import { DocumentEvidenceModel } from './document-evidence.models.js';

export const DOCUMENT_PIPELINE_VERSION = 'p4a-v1';

const DOCUMENT_SIGNATURES = [
  { mimeType: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
] as const;

function safeDisplayName(original: string): string {
  const cleaned = [...original]
    .map((character) =>
      character === '/' || character === '\\' || character.charCodeAt(0) < 32 ? '_' : character,
    )
    .join('')
    .slice(0, 200);
  return cleaned || 'supplier-document';
}

function sniffDocumentMimeType(file: Buffer, fileName: string): DocumentIntelligenceMimeType {
  for (const signature of DOCUMENT_SIGNATURES) {
    if (signature.bytes.every((byte, index) => file[index] === byte)) return signature.mimeType;
  }
  if (extname(fileName).toLowerCase() !== '.csv') return 'application/octet-stream';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file);
    if (text.includes('\0')) return 'application/octet-stream';
    return 'text/csv';
  } catch {
    return 'application/octet-stream';
  }
}

function processingIdempotencyKey(document: SourceDocumentDoc): string {
  return createHash('sha256')
    .update(`${document.id}:${document.sha256}:${DOCUMENT_PIPELINE_VERSION}`, 'utf8')
    .digest('hex');
}

function jobView(job: DocumentProcessingJobDoc) {
  return {
    id: job.id as string,
    sourceDocumentId: String(job.sourceDocumentId),
    status: job.status,
    malwareScanStatus: job.malwareScanStatus,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    processingWarnings: job.processingWarnings,
    lastFailure: job.lastFailure
      ? {
          stage: job.lastFailure.stage,
          code: job.lastFailure.code,
          message: job.lastFailure.message,
        }
      : null,
    finishedAt: job.finishedAt ?? null,
  };
}

export interface DocumentIntelligenceUpload {
  supplierId: string;
  file: Buffer;
  fileName: string;
  notes?: string;
}

export async function uploadIntelligenceDocument(
  input: DocumentIntelligenceUpload,
  storage: StorageAdapter,
  actor: Actor,
  limits: DocumentParserLimits,
) {
  if (input.file.length === 0 || input.file.length > limits.maxFileBytes) {
    throw new HttpError(
      413,
      'file_too_large',
      'The file is empty or exceeds the configured limit.',
    );
  }
  const supplier = mongoose.isValidObjectId(input.supplierId)
    ? await SupplierModel.findById(input.supplierId)
    : null;
  if (!supplier) throw notFound('Supplier');

  const fileName = safeDisplayName(input.fileName);
  const mimeType = sniffDocumentMimeType(input.file, fileName);

  const sha256 = createHash('sha256').update(input.file).digest('hex');
  const duplicate = () =>
    SourceDocumentModel.findOne({ supplierId: supplier._id, sha256 })
      .select('_id fileName receivedAt')
      .lean();
  const existing = await duplicate();
  if (existing) {
    throw new HttpError(
      409,
      'duplicate_document',
      `This exact file was already uploaded for this supplier as "${existing.fileName}".`,
      {
        existingId: String(existing._id),
        existingFileName: existing.fileName,
        existingReceivedAt: existing.receivedAt.toISOString(),
      },
    );
  }

  const fileKey = sourceDocumentKey(String(supplier._id), sha256, mimeType);
  await storage.put(fileKey, input.file, mimeType);

  let document: SourceDocumentDoc;
  try {
    document = await SourceDocumentModel.create({
      supplierId: supplier._id,
      intakePipeline: 'document-intelligence',
      fileKey,
      fileName,
      mimeType,
      sizeBytes: input.file.length,
      sha256,
      receivedAt: new Date(),
      uploadedBy: actor.id,
      extractionStatus: 'uploaded',
      notes: input.notes || undefined,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const winner = await duplicate();
      if (winner) {
        throw new HttpError(
          409,
          'duplicate_document',
          `This exact file was already uploaded for this supplier as "${winner.fileName}".`,
          {
            existingId: String(winner._id),
            existingFileName: winner.fileName,
            existingReceivedAt: winner.receivedAt.toISOString(),
          },
        );
      }
    }
    throw error;
  }

  await recordAudit({
    actor,
    action: 'documentIntelligence.sourceDocument.upload',
    entityType: 'sourceDocument',
    entityId: document.id as string,
    after: { supplierId: String(supplier._id), fileName, mimeType, sha256 },
    ip: actor.ip,
  });

  const job = await enqueueDocumentJob({
    sourceDocumentId: document._id,
    idempotencyKey: processingIdempotencyKey(document),
    pipelineVersion: DOCUMENT_PIPELINE_VERSION,
  });
  return { documentId: document.id as string, processing: jobView(job) };
}

export async function getDocumentProcessingStatus(sourceDocumentId: string) {
  if (!mongoose.isValidObjectId(sourceDocumentId)) throw notFound('Document processing job');
  const [document, job] = await Promise.all([
    SourceDocumentModel.findOne({
      _id: sourceDocumentId,
      intakePipeline: 'document-intelligence',
    })
      .select('_id fileName mimeType sizeBytes')
      .lean(),
    DocumentProcessingJobModel.findOne({ sourceDocumentId }).sort({ createdAt: -1 }),
  ]);
  if (!document || !job) throw notFound('Document processing job');
  return {
    document: {
      id: String(document._id),
      fileName: document.fileName,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
    },
    processing: jobView(job),
  };
}

export async function getDocumentIntelligenceFile(
  sourceDocumentId: string,
  storage: StorageAdapter,
) {
  if (!mongoose.isValidObjectId(sourceDocumentId)) throw notFound('Source document');
  const document = await SourceDocumentModel.findOne({
    _id: sourceDocumentId,
    intakePipeline: 'document-intelligence',
  }).select('fileKey fileName mimeType');
  if (!document) throw notFound('Source document');
  const infected = await DocumentProcessingJobModel.exists({
    sourceDocumentId: document._id,
    status: 'infected',
  });
  if (infected) {
    throw new HttpError(
      410,
      'infected_document',
      'This file is quarantined and cannot be downloaded.',
    );
  }
  return {
    data: await storage.get(document.fileKey),
    mimeType: document.mimeType,
    fileName: document.fileName,
  };
}

export async function listDocumentEvidence(sourceDocumentId: string, page: number, limit: number) {
  if (!mongoose.isValidObjectId(sourceDocumentId)) throw notFound('Source document');
  const sourceId = new mongoose.Types.ObjectId(sourceDocumentId);
  if (
    !(await SourceDocumentModel.exists({
      _id: sourceId,
      intakePipeline: 'document-intelligence',
    }))
  ) {
    throw notFound('Source document');
  }
  const filter = { sourceDocumentId: sourceId };
  const [items, total] = await Promise.all([
    DocumentEvidenceModel.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DocumentEvidenceModel.countDocuments(filter),
  ]);
  return {
    items: items.map((item) => ({
      id: String(item._id),
      kind: item.kind,
      location: item.location,
      content: item.content,
      metadata: item.metadata ?? null,
      reviewStatus: item.reviewStatus,
      createdAt: item.createdAt,
    })),
    page,
    limit,
    total,
  };
}

export async function retryDocumentProcessing(sourceDocumentId: string) {
  if (!mongoose.isValidObjectId(sourceDocumentId)) throw notFound('Source document');
  const document = await SourceDocumentModel.findOne({
    _id: sourceDocumentId,
    intakePipeline: 'document-intelligence',
  });
  if (!document) throw notFound('Source document');

  const idempotencyKey = processingIdempotencyKey(document);
  const existing = await DocumentProcessingJobModel.findOne({
    sourceDocumentId: document._id,
    idempotencyKey,
  });
  if (!existing) {
    const job = await enqueueDocumentJob({
      sourceDocumentId: document._id,
      idempotencyKey,
      pipelineVersion: DOCUMENT_PIPELINE_VERSION,
    });
    return jobView(job);
  }
  if (
    existing.status === 'queued' ||
    existing.status === 'scanning' ||
    existing.status === 'parsing'
  ) {
    return jobView(existing);
  }
  if (existing.status !== 'failed' && existing.status !== 'scan_unavailable') {
    throw new HttpError(409, 'processing_not_retryable', 'This document cannot be retried.');
  }

  const reset = await DocumentProcessingJobModel.findOneAndUpdate(
    { _id: existing._id, status: existing.status },
    {
      $set: {
        status: 'queued',
        malwareScanStatus: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        processingWarnings: [],
      },
      $unset: { lease: 1, activeRunId: 1, lastFailure: 1, finishedAt: 1 },
    },
    { returnDocument: 'after' },
  );
  if (reset) return jobView(reset);
  const current = await DocumentProcessingJobModel.findById(existing._id);
  if (!current) throw notFound('Document processing job');
  return jobView(current);
}
