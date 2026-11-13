import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export const DOCUMENT_EVIDENCE_KINDS = [
  'pdf_text',
  'spreadsheet_cell',
  'csv_record',
  'image_reference',
] as const;

export const DOCUMENT_EVIDENCE_REVIEW_STATUSES = ['unreviewed', 'accepted', 'rejected'] as const;

export const MAX_EVIDENCE_CONTENT_BYTES = 64 * 1024;
export const MAX_EVIDENCE_METADATA_BYTES = 16 * 1024;

function isBoundedJson(value: unknown, maximumBytes: number): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 20_000 || depth > 12) return false;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      return true;
    }
    if (typeof item !== 'object' || Buffer.isBuffer(item) || item instanceof Date) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) return item.every((entry) => visit(entry, depth + 1));
    if (Object.getPrototypeOf(item) !== Object.prototype) return false;
    return Object.entries(item).every(([key, entry]) => {
      return key !== '__proto__' && key !== 'constructor' && visit(entry, depth + 1);
    });
  };

  if (!visit(value, 0)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes;
  } catch {
    return false;
  }
}

function validLocation(
  kind: (typeof DOCUMENT_EVIDENCE_KINDS)[number],
  location: {
    page?: number;
    sheet?: string;
    row?: number;
    column?: number;
    cell?: string;
    segment?: number;
  },
): boolean {
  switch (kind) {
    case 'pdf_text':
    case 'image_reference':
      return Number.isSafeInteger(location.page) && (location.page ?? 0) > 0;
    case 'spreadsheet_cell': {
      const { sheet, cell } = location;
      return (
        typeof sheet === 'string' &&
        sheet.trim().length > 0 &&
        sheet.length <= 255 &&
        typeof cell === 'string' &&
        cell.trim().length > 0 &&
        cell.length <= 32 &&
        Number.isSafeInteger(location.row) &&
        Number.isSafeInteger(location.column) &&
        (location.row ?? 0) > 0 &&
        (location.column ?? 0) > 0
      );
    }
    case 'csv_record':
      return (
        Number.isSafeInteger(location.row) &&
        Number.isSafeInteger(location.column) &&
        (location.row ?? 0) > 0 &&
        (location.column ?? 0) > 0
      );
  }
}

const documentEvidenceSchema = new Schema(
  {
    sourceDocumentId: {
      type: Schema.Types.ObjectId,
      ref: 'SourceDocument',
      required: true,
      immutable: true,
    },
    processingJobId: {
      type: Schema.Types.ObjectId,
      ref: 'DocumentProcessingJob',
      required: true,
      immutable: true,
    },
    /** Stable identity of this evidence within one processing job. */
    evidenceKey: { type: String, required: true, immutable: true, maxlength: 128 },
    kind: {
      type: String,
      required: true,
      enum: DOCUMENT_EVIDENCE_KINDS,
      immutable: true,
    },
    /** Location in the original document. Only applicable fields are set. */
    location: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) =>
          value !== null && typeof value === 'object' && isBoundedJson(value, 4096),
        message: 'Evidence provenance must be bounded JSON data.',
      },
    },
    /** Extracted content; never treated as an approved rate automatically. */
    content: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => isBoundedJson(value, MAX_EVIDENCE_CONTENT_BYTES),
        message: `Evidence content must be JSON data no larger than ${MAX_EVIDENCE_CONTENT_BYTES} bytes.`,
      },
    },
    /** Parser-specific details, such as parser name or detected data type. */
    metadata: {
      type: Schema.Types.Mixed,
      immutable: true,
      validate: {
        validator: (value: unknown) =>
          value === undefined || isBoundedJson(value, MAX_EVIDENCE_METADATA_BYTES),
        message: `Evidence metadata must be JSON data no larger than ${MAX_EVIDENCE_METADATA_BYTES} bytes.`,
      },
    },
    reviewStatus: {
      type: String,
      required: true,
      enum: DOCUMENT_EVIDENCE_REVIEW_STATUSES,
      default: 'unreviewed',
    },
  },
  {
    collection: 'documentEvidence',
    timestamps: true,
    minimize: false,
  },
);

documentEvidenceSchema.pre('validate', function () {
  if (
    !validLocation(
      this.kind as (typeof DOCUMENT_EVIDENCE_KINDS)[number],
      (this.location ?? {}) as Parameters<typeof validLocation>[1],
    )
  ) {
    this.invalidate('location', 'Evidence provenance is invalid for its evidence kind.');
  }
});

// A retry of the same processing job cannot create duplicate evidence.
documentEvidenceSchema.index({ processingJobId: 1, evidenceKey: 1 }, { unique: true });

documentEvidenceSchema.index({ sourceDocumentId: 1, createdAt: 1 });
documentEvidenceSchema.index({ processingJobId: 1 });

export type DocumentEvidenceDoc = HydratedDocument<InferSchemaType<typeof documentEvidenceSchema>>;

export const DocumentEvidenceModel = model('DocumentEvidence', documentEvidenceSchema);
