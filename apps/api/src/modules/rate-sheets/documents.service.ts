/**
 * Source documents: upload with duplicate detection, and extraction into
 * draft packs (docs/03 section 2, steps 1 to 5).
 */
import { createHash } from 'node:crypto';
import {
  ExtractionResultSchema,
  RATE_PACKAGE_TRANSITIONS,
  RATE_SHEET_MIME_TYPES,
  assertTransition,
  parseMajorToMinor,
  type ExtractedPack,
  type ExtractionResult,
  type ExtractionStatus,
  type ListQuery,
  type Paged,
  type RatePackageDetail,
  type RateSheetMimeType,
  type SourceDocumentView,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import {
  ExtractionFormatError,
  type ExtractionAdapter,
} from '../../adapters/extraction/extraction.js';
import { rateSheetKey, type StorageAdapter } from '../../adapters/storage/storage.js';
import { HttpError, notFound } from '../../lib/http-error.js';
import { normalizeName } from '../../lib/names.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { UserModel } from '../users/user.model.js';
import { HotelIndex } from './matching.js';
import { getPackageDetail, revalidate, syncDocumentStatus, toSummary } from './packages.service.js';
import {
  HotelRateModel,
  RatePackageModel,
  SourceDocumentModel,
  VisaRateModel,
  type SourceDocumentDoc,
} from './rate-sheet.models.js';

/** Shown to staff whenever extraction does not produce packs (docs/03 section 2.3). */
export const EXTRACTION_FAILED_MESSAGE = 'Extraction failed — enter manually or retry';
/** A document left "extracting" this long is assumed stuck and may be retried. */
const EXTRACTION_STALE_MS = 10 * 60 * 1000;

const id = (value: unknown): string => String(value);

// --- file checks ----------------------------------------------------------
const SIGNATURES: Record<RateSheetMimeType, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

/**
 * The type is decided by the file's first bytes, not by its name or the
 * browser's claim, so a renamed file cannot pass as a PDF.
 */
export function sniffMimeType(file: Buffer): RateSheetMimeType | null {
  for (const mimeType of RATE_SHEET_MIME_TYPES) {
    if (SIGNATURES[mimeType].every((byte, index) => file[index] === byte)) return mimeType;
  }
  return null;
}

// --- views ----------------------------------------------------------------
async function findDocumentOr404(documentId: string): Promise<SourceDocumentDoc> {
  const doc = mongoose.isValidObjectId(documentId)
    ? await SourceDocumentModel.findOne({
        _id: documentId,
        intakePipeline: { $ne: 'document-intelligence' },
      })
    : null;
  if (!doc) throw notFound('Rate sheet');
  return doc;
}

async function toViews(docs: SourceDocumentDoc[]): Promise<SourceDocumentView[]> {
  const [suppliers, users, packs] = await Promise.all([
    SupplierModel.find({ _id: { $in: docs.map((d) => d.supplierId) } })
      .select('name')
      .lean(),
    UserModel.find({ _id: { $in: docs.map((d) => d.uploadedBy).filter(Boolean) } })
      .select('name')
      .lean(),
    RatePackageModel.find({ sourceDocumentId: { $in: docs.map((d) => d._id) } }).sort({
      nightFrom: 1,
      version: -1,
    }),
  ]);
  const supplierNames = new Map(suppliers.map((s) => [id(s._id), s.name]));
  const userNames = new Map(users.map((u) => [id(u._id), u.name]));

  // Built field by field: extractionRaw and the storage key never leave the API.
  return docs.map((doc) => ({
    id: doc.id as string,
    supplierId: id(doc.supplierId),
    supplierName: supplierNames.get(id(doc.supplierId)) ?? '',
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    receivedAt: doc.receivedAt,
    uploadedByName: doc.uploadedBy ? (userNames.get(id(doc.uploadedBy)) ?? null) : null,
    extractionStatus: doc.extractionStatus as ExtractionStatus,
    extractionModel: doc.extractionModel ?? null,
    extractionError: doc.extractionError ?? null,
    notes: doc.notes ?? null,
    packages: packs
      .filter((pack) => id(pack.sourceDocumentId) === doc.id && pack.status !== 'rejected')
      .map(toSummary),
  }));
}

export async function getDocument(documentId: string): Promise<SourceDocumentView> {
  const [view] = await toViews([await findDocumentOr404(documentId)]);
  return view as SourceDocumentView;
}

export async function listDocuments(query: ListQuery): Promise<Paged<SourceDocumentView>> {
  const [docs, total] = await Promise.all([
    SourceDocumentModel.find({ intakePipeline: { $ne: 'document-intelligence' } })
      .sort({ receivedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SourceDocumentModel.countDocuments({ intakePipeline: { $ne: 'document-intelligence' } }),
  ]);
  return { items: await toViews(docs), page: query.page, limit: query.limit, total };
}

export async function getDocumentFile(
  documentId: string,
  storage: StorageAdapter,
): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
  const doc = await findDocumentOr404(documentId);
  return { data: await storage.get(doc.fileKey), mimeType: doc.mimeType, fileName: doc.fileName };
}

// --- upload ---------------------------------------------------------------
/** The uploaded name, made safe to show: no path separators or control characters. */
function displayName(original: string): string {
  const cleaned = [...original]
    .map((char) => (char === '/' || char === '\\' || char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .slice(0, 200);
  return cleaned || 'rate-sheet';
}

export async function uploadDocument(
  input: { supplierId: string; file: Buffer; fileName: string; notes?: string },
  storage: StorageAdapter,
  actor: Actor,
): Promise<SourceDocumentView> {
  const supplier = mongoose.isValidObjectId(input.supplierId)
    ? await SupplierModel.findById(input.supplierId)
    : null;
  if (!supplier) throw notFound('Supplier');

  const mimeType = sniffMimeType(input.file);
  if (!mimeType) {
    throw new HttpError(400, 'unsupported_file', 'Upload a PDF, PNG or JPEG rate sheet.');
  }

  const sha256 = createHash('sha256').update(input.file).digest('hex');
  // Same bytes for the same supplier = the same document, whatever it is called.
  const duplicate = () =>
    SourceDocumentModel.findOne({ supplierId: supplier._id, sha256 })
      .select('fileName receivedAt')
      .lean();
  const asDuplicate = (existing: { _id: unknown; fileName: string; receivedAt: Date }) =>
    new HttpError(
      409,
      'duplicate_document',
      `This exact file was already uploaded for this supplier as "${existing.fileName}".`,
      {
        // Enough for the screen to point staff at the record that already exists.
        existingId: id(existing._id),
        existingFileName: existing.fileName,
        existingReceivedAt: existing.receivedAt.toISOString(),
      },
    );
  const existing = await duplicate();
  if (existing) throw asDuplicate(existing);

  const fileKey = rateSheetKey(supplier.id as string, sha256, mimeType);
  await storage.put(fileKey, input.file, mimeType);

  let doc: SourceDocumentDoc;
  try {
    doc = await SourceDocumentModel.create({
      supplierId: supplier._id,
      fileKey,
      // Kept for display only; the storage key is built from the hash.
      fileName: displayName(input.fileName),
      mimeType,
      sizeBytes: input.file.length,
      sha256,
      receivedAt: new Date(),
      uploadedBy: actor.id,
      extractionStatus: 'uploaded',
      notes: input.notes || undefined,
    });
  } catch (error) {
    // Two uploads of the same file raced; the unique index caught the second.
    if ((error as { code?: number }).code === 11000) {
      const winner = await duplicate();
      if (winner) throw asDuplicate(winner);
    }
    throw error;
  }

  await recordAudit({
    actor,
    action: 'sourceDocument.upload',
    entityType: 'sourceDocument',
    entityId: doc.id as string,
    after: { supplierId: supplier.id as string, fileName: doc.fileName, mimeType, sha256 },
    ip: actor.ip,
  });
  return getDocument(doc.id as string);
}

// --- extraction -----------------------------------------------------------
/** Whole SAR as printed -> halalas, without float arithmetic. Bad values become null. */
function toMinor(printed: number | null | undefined): number | null {
  if (printed === null || printed === undefined || !Number.isFinite(printed) || printed < 0) {
    return null;
  }
  try {
    return parseMajorToMinor(String(printed));
  } catch {
    return null;
  }
}

function describeProblems(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ')
    .slice(0, 1500);
}

/** Ask the model; if the answer does not fit the schema, ask once more with the reason. */
async function extractWithRetry(
  adapter: ExtractionAdapter,
  doc: SourceDocumentDoc,
  file: Buffer,
): Promise<{ result: ExtractionResult | null; raw: unknown }> {
  let previousError: string | undefined;
  let raw: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await adapter.extract({
        file,
        mimeType: doc.mimeType as RateSheetMimeType,
        fileName: doc.fileName,
        previousError,
      });
    } catch (error) {
      if (!(error instanceof ExtractionFormatError)) throw error;
      previousError = error.message;
      continue;
    }
    const parsed = ExtractionResultSchema.safeParse(raw);
    if (parsed.success) return { result: parsed.data, raw };
    previousError = describeProblems(parsed.error.issues);
  }
  return { result: null, raw };
}

async function ingestPack(
  doc: SourceDocumentDoc,
  extracted: ExtractedPack,
  hotels: HotelIndex,
): Promise<void> {
  const pack = await RatePackageModel.create({
    supplierId: doc.supplierId,
    sourceDocumentId: doc._id,
    packName: extracted.packName,
    seasonLabel: extracted.seasonLabel ?? undefined,
    nightFrom: extracted.nightFrom,
    nightTo: extracted.nightTo,
    effectiveFrom: extracted.effectiveFrom ?? null,
    issueDate: extracted.issueDate ?? null,
    currency: extracted.currency.toUpperCase(),
    status: 'draft',
    version: 1,
  });

  await VisaRateModel.create({
    packageId: pack._id,
    direct: { perPersonMinor: toMinor(extracted.visa.directPerPerson) },
    indirectByGroupSize: {
      '1': toMinor(extracted.visa.indirectByGroupSize['1']),
      '2': toMinor(extracted.visa.indirectByGroupSize['2']),
      '3': toMinor(extracted.visa.indirectByGroupSize['3']),
      '4': toMinor(extracted.visa.indirectByGroupSize['4']),
    },
    infantMinor: toMinor(extracted.visa.infant),
    appliesNote: extracted.visa.notes ?? undefined,
  });

  const taken = new Set<string>();
  const rows = extracted.hotels.map((row, index) => {
    const match = hotels.match(row.city, row.name, row.aliasesPrinted);
    // A second row for the same hotel stays unconfirmed, for staff to remove.
    const repeated = match.hotelId !== null && taken.has(match.hotelId);
    if (match.hotelId && !repeated) taken.add(match.hotelId);
    return {
      packageId: pack._id,
      hotelId: repeated ? undefined : (match.hotelId ?? undefined),
      suggestedHotelId: repeated ? match.hotelId : (match.suggestedHotelId ?? undefined),
      printed: {
        city: row.city,
        name: row.name,
        aliases: row.aliasesPrinted,
        distanceText: row.distanceText ?? undefined,
        distanceMeters:
          row.distanceMeters !== null && row.distanceMeters !== undefined && row.distanceMeters >= 0
            ? Math.round(row.distanceMeters)
            : undefined,
        transportText: row.transportText ?? undefined,
      },
      pricingMode: row.pricingMode,
      roomPriceMinor: row.pricingMode === 'on_request' ? null : toMinor(row.room),
      perPersonMinor:
        row.pricingMode === 'on_request'
          ? { quint: null, quad: null, triple: null, double: null }
          : {
              quint: toMinor(row.perPerson.quint),
              quad: toMinor(row.perPerson.quad),
              triple: toMinor(row.perPerson.triple),
              double: toMinor(row.perPerson.double),
            },
      flatNote: row.flatNote ?? undefined,
      sourcePage: row.page,
      sourceRow: row.row || index + 1,
      confidence: row.confidence,
      edited: false,
    };
  });
  if (rows.length > 0) await HotelRateModel.insertMany(rows);

  // Moves the pack from draft to needs_review with its validation attached.
  await revalidate(pack);
}

/** Checks that extraction may start and marks the document as extracting. */
export async function beginExtraction(
  documentId: string,
  adapter: ExtractionAdapter | undefined,
): Promise<SourceDocumentDoc> {
  if (!adapter) {
    throw new HttpError(
      503,
      'extraction_not_configured',
      'Automatic reading is not set up (no ANTHROPIC_API_KEY). Enter the sheet by hand.',
    );
  }
  const doc = await findDocumentOr404(documentId);
  if (
    await RatePackageModel.exists({
      sourceDocumentId: doc._id,
      status: { $in: ['published', 'superseded'] },
    })
  ) {
    throw new HttpError(
      409,
      'already_published',
      'Rates from this sheet have been published. Upload the new sheet instead of reading this one again.',
    );
  }
  const startedAt = doc.extractionStartedAt?.getTime() ?? 0;
  if (doc.extractionStatus === 'extracting' && Date.now() - startedAt < EXTRACTION_STALE_MS) {
    throw new HttpError(409, 'extraction_in_progress', 'This sheet is being read right now.');
  }
  doc.extractionStatus = 'extracting';
  doc.extractionStartedAt = new Date();
  doc.set('extractionError', undefined);
  await doc.save();
  return doc;
}

/**
 * Reads the file and creates one pack per pack found, each awaiting review.
 * Never throws: any failure is recorded on the document for staff to see,
 * because this may run after the HTTP response has been sent.
 */
export async function completeExtraction(
  doc: SourceDocumentDoc,
  adapter: ExtractionAdapter,
  storage: StorageAdapter,
  actor: Actor,
): Promise<void> {
  let packsCreated = 0;
  let failure: string | null = null;
  try {
    const file = await storage.get(doc.fileKey);
    const { result, raw } = await extractWithRetry(adapter, doc, file);
    doc.set('extractionRaw', raw);
    doc.extractionModel = adapter.model;

    if (!result) {
      failure = 'invalid_answer';
    } else {
      // Earlier unpublished readings of this file are retired, not deleted.
      const stale = await RatePackageModel.find({
        sourceDocumentId: doc._id,
        status: { $in: ['draft', 'needs_review'] },
      });
      for (const pack of stale) {
        assertTransition(
          RATE_PACKAGE_TRANSITIONS,
          pack.status as 'draft' | 'needs_review',
          'rejected',
        );
        pack.status = 'rejected';
        await pack.save();
      }
      const hotels = await HotelIndex.load();
      for (const extracted of result.packs) {
        await ingestPack(doc, extracted, hotels);
        packsCreated += 1;
      }
    }
  } catch (error) {
    // The reason is kept out of the message: it can name hosts or keys.
    failure = error instanceof Error ? error.name : 'unknown';
  }

  doc.extractionStatus = 'needs_review';
  doc.set('extractionError', failure ? EXTRACTION_FAILED_MESSAGE : undefined);
  await doc.save();
  if (packsCreated > 0) await syncDocumentStatus(doc._id);

  await recordAudit({
    actor,
    action: failure ? 'sourceDocument.extract_failed' : 'sourceDocument.extract',
    entityType: 'sourceDocument',
    entityId: doc.id as string,
    after: { model: adapter.model, packsCreated, ...(failure ? { failure } : {}) },
    ip: actor.ip,
  });
}

/**
 * Extraction runs inside the API process. If the process stops mid-way (a
 * restart or deploy), the document would stay "extracting" for ever and the
 * staff page would keep showing "reading". Once a reading is older than
 * EXTRACTION_STALE_MS it is marked failed exactly as a failed reading is, so
 * staff see "Extraction failed — enter manually or retry" and can retry.
 * Run at start-up and every minute (server.ts). Returns how many it marked.
 */
export async function recoverStaleExtractions(
  actor: Actor,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - EXTRACTION_STALE_MS);
  const stuck = await SourceDocumentModel.find({
    extractionStatus: 'extracting',
    $or: [{ extractionStartedAt: { $lt: cutoff } }, { extractionStartedAt: { $exists: false } }],
  })
    .select('_id extractionStartedAt')
    .limit(100)
    .lean();
  let marked = 0;
  for (const doc of stuck) {
    // Only if it is still the same stuck reading: a reading that has just
    // finished, or a fresh retry, is left alone.
    const result = await SourceDocumentModel.updateOne(
      {
        _id: doc._id,
        extractionStatus: 'extracting',
        extractionStartedAt: doc.extractionStartedAt ?? { $exists: false },
      },
      { $set: { extractionStatus: 'needs_review', extractionError: EXTRACTION_FAILED_MESSAGE } },
    );
    if (result.modifiedCount !== 1) continue;
    marked += 1;
    await recordAudit({
      actor,
      action: 'sourceDocument.extract_failed',
      entityType: 'sourceDocument',
      entityId: String(doc._id),
      after: { failure: 'interrupted' },
    });
  }
  return marked;
}

/** "Ramadan Pack 01", "ramadan  pack 01." and "RAMADAN PACK-01" are one name. */
function comparablePackName(name: string): string {
  return normalizeName(name.replace(/[^\p{L}\p{N}]+/gu, ' '));
}

/** An empty pack to type a sheet into, when automatic reading is not possible. */
export async function createBlankPackage(
  documentId: string,
  packName: string,
  actor: Actor,
): Promise<RatePackageDetail> {
  const doc = await findDocumentOr404(documentId);

  // Pressing "Enter by hand" twice must not leave two copies of one pack.
  const open = await RatePackageModel.find({
    sourceDocumentId: doc._id,
    status: { $ne: 'rejected' },
  }).select('packName');
  const same = open.find(
    (other) => comparablePackName(other.packName) === comparablePackName(packName),
  );
  if (same) {
    throw new HttpError(
      409,
      'pack_name_taken',
      `This sheet already has a pack called "${same.packName}". Open that one, or use the name printed on the other pack.`,
      { existingId: same.id as string, existingPackName: same.packName },
    );
  }

  const pack = await RatePackageModel.create({
    supplierId: doc.supplierId,
    sourceDocumentId: doc._id,
    packName,
    currency: 'SAR',
    status: 'draft',
    version: 1,
  });
  await VisaRateModel.create({ packageId: pack._id });
  await revalidate(pack);
  await syncDocumentStatus(doc._id);
  await recordAudit({
    actor,
    action: 'ratePackage.create',
    entityType: 'ratePackage',
    entityId: pack.id as string,
    after: { packName, sourceDocumentId: doc.id as string, enteredByHand: true },
    ip: actor.ip,
  });
  return getPackageDetail(pack.id as string);
}
