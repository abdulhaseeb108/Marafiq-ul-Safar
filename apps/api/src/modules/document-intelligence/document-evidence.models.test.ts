import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  DocumentEvidenceModel,
  MAX_EVIDENCE_CONTENT_BYTES,
  MAX_EVIDENCE_METADATA_BYTES,
} from './document-evidence.models.js';

describe('document evidence model', () => {
  const evidenceFields = () => ({
    sourceDocumentId: new mongoose.Types.ObjectId(),
    processingJobId: new mongoose.Types.ObjectId(),
    evidenceKey: `pdf-page-1:${new mongoose.Types.ObjectId()}`,
    kind: 'pdf_text' as const,
    location: { page: 1 },
    content: 'Sample extracted document text',
  });

  it('creates unreviewed evidence by default', async () => {
    const evidence = await DocumentEvidenceModel.create(evidenceFields());

    expect(evidence.reviewStatus).toBe('unreviewed');
    expect(evidence.kind).toBe('pdf_text');
    expect(evidence.location?.page).toBe(1);
  });

  it('enforces unique evidence keys within a processing job', async () => {
    const fields = evidenceFields();
    await DocumentEvidenceModel.create(fields);

    await expect(DocumentEvidenceModel.create(fields)).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('declares indexes for source documents and processing jobs', () => {
    const indexes = DocumentEvidenceModel.schema.indexes();

    expect(indexes).toContainEqual([
      { processingJobId: 1, evidenceKey: 1 },
      expect.objectContaining({ unique: true }),
    ]);

    expect(indexes).toContainEqual([{ sourceDocumentId: 1, createdAt: 1 }, expect.any(Object)]);
  });

  it('rejects unsupported evidence kinds', async () => {
    const evidence = new DocumentEvidenceModel({
      ...evidenceFields(),
      kind: 'published_rate',
    });

    await expect(evidence.validate()).rejects.toThrow(/`published_rate` is not a valid enum value/);
  });

  it('rejects unsupported review statuses', async () => {
    const evidence = new DocumentEvidenceModel({
      ...evidenceFields(),
      reviewStatus: 'published',
    });

    await expect(evidence.validate()).rejects.toThrow(/`published` is not a valid enum value/);
  });

  it('rejects evidence whose provenance does not match its kind', async () => {
    const evidence = new DocumentEvidenceModel({
      ...evidenceFields(),
      kind: 'spreadsheet_cell',
      location: { page: 1 },
    });

    await expect(evidence.validate()).rejects.toThrow(/provenance is invalid/);
  });

  it('bounds JSON content and metadata', async () => {
    const oversizedContent = new DocumentEvidenceModel({
      ...evidenceFields(),
      content: 'x'.repeat(MAX_EVIDENCE_CONTENT_BYTES + 1),
    });
    const oversizedMetadata = new DocumentEvidenceModel({
      ...evidenceFields(),
      metadata: { detail: 'x'.repeat(MAX_EVIDENCE_METADATA_BYTES + 1) },
    });

    await expect(oversizedContent.validate()).rejects.toThrow(/Evidence content must be JSON data/);
    await expect(oversizedMetadata.validate()).rejects.toThrow(
      /Evidence metadata must be JSON data/,
    );
  });

  it('rejects binary and non-finite content instead of persisting non-JSON values', async () => {
    const binary = new DocumentEvidenceModel({
      ...evidenceFields(),
      content: Buffer.from('not structured evidence'),
    });
    const nonFinite = new DocumentEvidenceModel({
      ...evidenceFields(),
      content: { value: Number.POSITIVE_INFINITY },
    });

    await expect(binary.validate()).rejects.toThrow(/Evidence content must be JSON data/);
    await expect(nonFinite.validate()).rejects.toThrow(/Evidence content must be JSON data/);
  });

  it('marks original evidence fields immutable while keeping review status mutable', () => {
    for (const field of [
      'sourceDocumentId',
      'processingJobId',
      'evidenceKey',
      'kind',
      'location',
      'content',
      'metadata',
    ]) {
      expect(DocumentEvidenceModel.schema.path(field)?.options.immutable).toBe(true);
    }
    expect(DocumentEvidenceModel.schema.path('reviewStatus')?.options.immutable).not.toBe(true);
  });
});
