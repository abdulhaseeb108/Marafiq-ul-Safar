import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const DOCUMENT_PROCESSING_STATUSES = [
  'queued',
  'scanning',
  'scan_unavailable',
  'parsing',
  'processed',
  'partial',
  'unmapped',
  'failed',
  'infected',
] as const;

export const MALWARE_SCAN_STATUSES = [
  'pending',
  'clean',
  'unavailable',
  'infected',
  'error',
] as const;

const documentProcessingJobSchema = new Schema(
  {
    sourceDocumentId: {
      type: Schema.Types.ObjectId,
      ref: 'SourceDocument',
      required: true,
    },
    /** Hash of source document identity and the processing pipeline version. */
    idempotencyKey: { type: String, required: true, unique: true },
    pipelineVersion: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: DOCUMENT_PROCESSING_STATUSES,
      default: 'queued',
    },
    malwareScanStatus: {
      type: String,
      required: true,
      enum: MALWARE_SCAN_STATUSES,
      default: 'pending',
    },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, default: 3 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    lease: {
      workerId: { type: String },
      token: { type: String },
      expiresAt: { type: Date },
      heartbeatAt: { type: Date },
    },
    activeRunId: { type: String },
    lastFailure: {
      stage: { type: String },
      code: { type: String },
      message: { type: String },
    },
    processingWarnings: {
      type: [{ type: String, maxlength: 500 }],
      default: [],
      validate: {
        validator: (value: string[]) => value.length <= 100,
        message: 'A processing job may contain at most 100 warnings.',
      },
    },
    finishedAt: { type: Date },
  },
  { collection: 'documentProcessingJobs', timestamps: true, minimize: false },
);

documentProcessingJobSchema.index({ sourceDocumentId: 1 });
documentProcessingJobSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
documentProcessingJobSchema.index({ status: 1, 'lease.expiresAt': 1, createdAt: 1 });

export type DocumentProcessingJobDoc = HydratedDocument<
  InferSchemaType<typeof documentProcessingJobSchema>
>;
export const DocumentProcessingJobModel = model(
  'DocumentProcessingJob',
  documentProcessingJobSchema,
);
