/**
 * The four collections behind rate sheets (docs/02 section 1):
 * sourceDocuments -> ratePackages -> hotelRates + visaRates.
 * Money is SAR halalas, stored as integers.
 */
import { EXTRACTION_STATUSES, RATE_PACKAGE_STATUSES, RATE_SHEET_MIME_TYPES } from '@marafiq/shared';
import { Schema, model } from 'mongoose';
import { DOCUMENT_INTELLIGENCE_MIME_TYPES } from '../document-intelligence/document-formats.js';

const { ObjectId, Mixed } = Schema.Types;

// --- sourceDocuments: the original file a supplier sent --------------------
const sourceDocumentSchema = new Schema(
  {
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    intakePipeline: {
      type: String,
      enum: ['rate-sheet', 'document-intelligence'],
      default: 'rate-sheet',
      immutable: true,
    },
    fileKey: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: {
      type: String,
      required: true,
      enum: [...new Set([...RATE_SHEET_MIME_TYPES, ...DOCUMENT_INTELLIGENCE_MIME_TYPES])],
    },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    uploadedBy: { type: ObjectId, ref: 'User' },
    extractionStatus: {
      type: String,
      required: true,
      enum: EXTRACTION_STATUSES,
      default: 'uploaded',
    },
    extractionStartedAt: { type: Date },
    extractionModel: { type: String },
    /** Raw model output, kept for diagnosis. Never returned by any API route. */
    extractionRaw: { type: Mixed },
    /** A plain message for staff when extraction failed. */
    extractionError: { type: String },
    notes: { type: String, trim: true },
  },
  { collection: 'sourceDocuments', timestamps: true },
);
// The same file from the same supplier is a duplicate (docs/03 section 2.1).
sourceDocumentSchema.index({ supplierId: 1, sha256: 1 }, { unique: true });

// --- ratePackages: one pack of nights and rates ----------------------------
const issueSchema = new Schema({ code: String, message: String, path: String }, { _id: false });

const ratePackageSchema = new Schema(
  {
    supplierId: { type: ObjectId, ref: 'Supplier', required: true },
    sourceDocumentId: { type: ObjectId, ref: 'SourceDocument', required: true },
    packName: { type: String, required: true, trim: true },
    seasonLabel: { type: String, trim: true },
    /** "YYYY-MM-DD", inclusive. Null on a draft whose dates could not be read. */
    nightFrom: { type: String, default: null },
    nightTo: { type: String, default: null },
    effectiveFrom: { type: String, default: null },
    issueDate: { type: String, default: null },
    currency: { type: String, required: true, default: 'SAR' },
    status: { type: String, required: true, enum: RATE_PACKAGE_STATUSES, default: 'draft' },
    version: { type: Number, required: true, default: 1 },
    /** The published pack this one replaces (or replaced) when published. */
    supersedesId: { type: ObjectId, ref: 'RatePackage', default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: ObjectId, ref: 'User', default: null },
    validation: {
      blocking: { type: [issueSchema], default: [] },
      warnings: { type: [issueSchema], default: [] },
    },
  },
  { collection: 'ratePackages', timestamps: true },
);
ratePackageSchema.index({ supplierId: 1, nightFrom: 1, nightTo: 1, status: 1 });
ratePackageSchema.index({ sourceDocumentId: 1 });

// --- hotelRates: one printed row -------------------------------------------
const hotelRateSchema = new Schema(
  {
    packageId: { type: ObjectId, ref: 'RatePackage', required: true },
    /** Unset while the printed name is an unconfirmed new-hotel candidate. */
    hotelId: { type: ObjectId, ref: 'Hotel' },
    /** What the sheet printed, kept so staff can check it against the original. */
    printed: {
      city: { type: String, required: true, enum: ['makkah', 'madinah'] },
      name: { type: String, required: true },
      aliases: { type: [String], default: [] },
      distanceText: { type: String },
      distanceMeters: { type: Number },
      transportText: { type: String },
    },
    /** A close match offered to staff; never applied automatically. */
    suggestedHotelId: { type: ObjectId, ref: 'Hotel' },
    pricingMode: {
      type: String,
      required: true,
      enum: ['derived_per_person', 'flat_per_room', 'on_request'],
    },
    /** Per room, per night. */
    roomPriceMinor: { type: Number, default: null },
    perPersonMinor: {
      quint: { type: Number, default: null },
      quad: { type: Number, default: null },
      triple: { type: Number, default: null },
      double: { type: Number, default: null },
    },
    flatNote: { type: String },
    sourcePage: { type: Number, required: true, default: 1 },
    sourceRow: { type: Number, required: true, default: 0 },
    confidence: { type: Number, required: true, default: 1 },
    /** True once a staff user changed the extracted values. */
    edited: { type: Boolean, required: true, default: false },
  },
  { collection: 'hotelRates', timestamps: true },
);
// "One row per hotel in a pack" is enforced by validation (duplicate_hotel
// blocks publishing) and by the services, because unconfirmed rows have no
// hotel yet and a unique index would have to ignore them.
hotelRateSchema.index({ packageId: 1, hotelId: 1 });
hotelRateSchema.index({ hotelId: 1 });

// --- visaRates: the header block of one pack -------------------------------
const visaRateSchema = new Schema(
  {
    packageId: { type: ObjectId, ref: 'RatePackage', required: true, unique: true },
    direct: { perPersonMinor: { type: Number, default: null } },
    indirectByGroupSize: {
      '1': { type: Number, default: null },
      '2': { type: Number, default: null },
      '3': { type: Number, default: null },
      '4': { type: Number, default: null },
    },
    infantMinor: { type: Number, default: null },
    /** Shown to staff only until confirmed with the supplier. */
    appliesNote: { type: String },
  },
  { collection: 'visaRates', timestamps: true },
);

export const SourceDocumentModel = model('SourceDocument', sourceDocumentSchema);
export const RatePackageModel = model('RatePackage', ratePackageSchema);
export const HotelRateModel = model('HotelRate', hotelRateSchema);
export const VisaRateModel = model('VisaRate', visaRateSchema);

// Taken from the models so they match exactly what queries return.
export type SourceDocumentDoc = InstanceType<typeof SourceDocumentModel>;
export type RatePackageDoc = InstanceType<typeof RatePackageModel>;
export type HotelRateDoc = InstanceType<typeof HotelRateModel>;
export type VisaRateDoc = InstanceType<typeof VisaRateModel>;
