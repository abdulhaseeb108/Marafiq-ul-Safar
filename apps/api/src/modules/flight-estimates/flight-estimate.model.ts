import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Staff-entered flight price ranges (docs/03 section 8). Shown to customers as
 * a range with "estimate, not a fare quote"; there is no live fare API in v1.
 * Money is PKR paisa, stored as integers.
 */
const flightEstimateSchema = new Schema(
  {
    originCity: { type: String, required: true, trim: true },
    destination: { type: String, required: true, enum: ['JED', 'MED'] },
    season: { type: String, trim: true },
    lowMinor: { type: Number, required: true },
    highMinor: { type: Number, required: true },
    currency: { type: String, required: true, enum: ['PKR'], default: 'PKR' },
    /** "YYYY-MM-DD": a date with no time zone, so a row expires on the same day everywhere. */
    validTo: { type: String, required: true },
    note: { type: String, trim: true },
    source: { type: String, required: true, trim: true },
  },
  { collection: 'flightEstimates', timestamps: true },
);

flightEstimateSchema.index({ originCity: 1, destination: 1, validTo: -1 });

export type FlightEstimateDoc = HydratedDocument<InferSchemaType<typeof flightEstimateSchema>>;
export const FlightEstimateModel = model('FlightEstimate', flightEstimateSchema);
