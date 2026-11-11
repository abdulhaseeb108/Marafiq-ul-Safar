import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Append-only history of SAR -> PKR rates. Nothing in the code updates or
 * deletes a row: a new rate is always a new document, so saved calculations
 * and sent quotes keep the rate they were priced with.
 *
 * The rate is a decimal string ("74.50"), never a float: money arithmetic
 * uses the scaled integer from money.ts (CLAUDE.md hard rule 1).
 */
const fxRateSchema = new Schema(
  {
    base: { type: String, required: true, enum: ['SAR'], default: 'SAR' },
    quote: { type: String, required: true, enum: ['PKR'], default: 'PKR' },
    rate: { type: String, required: true },
    effectiveAt: { type: Date, required: true },
    setBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'fxRates', timestamps: true },
);

fxRateSchema.index({ effectiveAt: -1, _id: -1 });

export type FxRateDoc = HydratedDocument<InferSchemaType<typeof fxRateSchema>>;
export const FxRateModel = model('FxRate', fxRateSchema);
