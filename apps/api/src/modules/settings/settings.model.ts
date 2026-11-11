import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** One document only; `singleton` is unique so a second one cannot be created. */
const settingsSchema = new Schema(
  {
    singleton: { type: String, required: true, unique: true, default: 'settings' },
    markupPercent: { type: Number, required: true, default: 0 },
    estimateExpiryHours: { type: Number, required: true, default: 72 },
    responseTimeText: { type: String, required: true, default: 'within 1 business day' },
    infantHotelCharge: { type: String, required: true, enum: ['none'], default: 'none' },
    childAsAdult: { type: Boolean, required: true, default: true },
    showSupplierRates: { type: Boolean, required: true, default: true },
  },
  { collection: 'settings', timestamps: true },
);

export type SettingsDoc = HydratedDocument<InferSchemaType<typeof settingsSchema>>;
export const SettingsModel = model('Settings', settingsSchema);
