import { ROLES } from '@marafiq/shared';
import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ROLES },
    /** Active TOTP secret, AES-256-GCM encrypted. */
    totpSecretEnc: { type: String },
    /** Generated during enrollment; becomes active once a code proves it. */
    totpPendingSecretEnc: { type: String },
    active: { type: Boolean, required: true, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { collection: 'users', timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model('User', userSchema);
