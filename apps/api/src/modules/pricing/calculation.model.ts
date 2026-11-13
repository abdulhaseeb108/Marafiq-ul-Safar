/**
 * calculations: saved engine results (docs/02 section 1). A saved calculation
 * is a snapshot: it is written once and never changed, so publishing new rates
 * never changes an old calculation (CLAUDE.md rule 4). Every update path below
 * is refused.
 */
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const { Mixed } = Schema.Types;

const calculationSchema = new Schema(
  {
    inputs: { type: Mixed, required: true },
    rateVersionSnapshot: { type: Mixed, required: true },
    fx: { type: Mixed, required: true },
    markupPercent: { type: Number, required: true },
    lineItems: { type: Mixed, required: true },
    missing: { type: Mixed, required: true },
    assumptions: { type: Mixed, required: true },
    exclusions: { type: Mixed, required: true },
    totals: { type: Mixed, required: true },
    calculatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    hash: { type: String, required: true },
    engineVersion: { type: String, required: true },
  },
  { collection: 'calculations', timestamps: true, minimize: false },
);
calculationSchema.index({ hash: 1 });

export class ImmutableCalculationError extends Error {
  constructor() {
    super('A saved calculation cannot be changed');
    this.name = 'ImmutableCalculationError';
  }
}

calculationSchema.pre('save', function () {
  if (!this.isNew) throw new ImmutableCalculationError();
});

for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
] as const) {
  calculationSchema.pre(op, function () {
    throw new ImmutableCalculationError();
  });
}

calculationSchema.pre('bulkWrite', function () {
  throw new ImmutableCalculationError();
});

export type CalculationDoc = HydratedDocument<InferSchemaType<typeof calculationSchema>>;
export const CalculationModel = model('Calculation', calculationSchema);
