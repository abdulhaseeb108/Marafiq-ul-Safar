import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Normalized name, for duplicate detection. */
    searchName: { type: String, required: true, unique: true },
    type: {
      type: String,
      required: true,
      enum: ['hotel_operator', 'transport', 'flight_partner', 'other'],
    },
    contactName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    notes: { type: String, trim: true },
    active: { type: Boolean, required: true, default: true },
  },
  { collection: 'suppliers', timestamps: true },
);

export type SupplierDoc = HydratedDocument<InferSchemaType<typeof supplierSchema>>;
export const SupplierModel = model('Supplier', supplierSchema);
