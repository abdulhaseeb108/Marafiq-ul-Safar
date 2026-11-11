import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const hotelSchema = new Schema(
  {
    city: { type: String, required: true, enum: ['makkah', 'madinah'] },
    canonicalName: { type: String, required: true, trim: true },
    aliases: { type: [String], required: true, default: [] },
    /**
     * Normalized canonical name and aliases, used to match names on rate
     * sheets and to keep names unique within a city. Emptied when the hotel
     * is merged away, so its names belong to the surviving hotel instead.
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
 * One name per city across all live hotels: multikey, so each (city, name)
 * pair is unique. Merged-away hotels are excluded, because they release their
 * names to the surviving hotel and so all hold an empty name list.
 */
hotelSchema.index(
  { city: 1, searchNames: 1 },
  { unique: true, partialFilterExpression: { mergedIntoId: null } },
);

export type HotelDoc = HydratedDocument<InferSchemaType<typeof hotelSchema>>;
export const HotelModel = model('Hotel', hotelSchema);
