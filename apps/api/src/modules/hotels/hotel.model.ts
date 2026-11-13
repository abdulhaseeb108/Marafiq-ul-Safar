import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const hotelSchema = new Schema(
  {
    city: { type: String, required: true, enum: ['makkah', 'madinah'] },
    canonicalName: { type: String, required: true, trim: true },
    aliases: { type: [String], required: true, default: [] },
    /**
     * Normalized canonical name and aliases, used to match names on rate
     * sheets and to keep names unique within a city. Replaced by a placeholder
     * when the hotel is merged away, so its names belong to the survivor.
     */
    searchNames: { type: [String], required: true, default: [] },
    distanceMeters: { type: Number },
    distanceNote: { type: String, default: '', trim: true },
    transport: {
      type: String,
      required: true,
      enum: ['walking', 'shuttle', 'unknown'],
      default: 'unknown',
    },
    /** Only when the supplier states it (docs/02 section 1). */
    starRating: { type: Number, min: 1, max: 5 },
    active: { type: Boolean, required: true, default: true },
    /** Set when this hotel was folded into another one. */
    mergedIntoId: { type: Schema.Types.ObjectId, ref: 'Hotel', default: null },
  },
  { collection: 'hotels', timestamps: true },
);

/**
 * One name per city across all hotels: multikey, so each (city, name) pair is
 * unique. A plain unique index, with no partial filter, so it behaves the same
 * on every MongoDB version. A merged-away hotel holds a single placeholder
 * (see MERGED_NAME_PREFIX) instead of real names.
 */
hotelSchema.index({ city: 1, searchNames: 1 }, { unique: true });

/**
 * Real search names are always lower case (lib/names.ts), so an upper-case
 * placeholder can never equal one, and including the hotel id keeps every
 * placeholder unique.
 */
export const MERGED_NAME_PREFIX = 'MERGED:';

export type HotelDoc = HydratedDocument<InferSchemaType<typeof hotelSchema>>;
export const HotelModel = model('Hotel', hotelSchema);
