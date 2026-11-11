import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * One document per issued refresh token. Not in docs/02; needed so refresh
 * tokens can rotate and be invalidated on logout. Holds only a keyed hash.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Shared by every rotated token of one login. */
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    mfa: { type: Boolean, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { collection: 'sessions', timestamps: true },
);

// MongoDB removes expired sessions on its own.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;
export const SessionModel = model('Session', sessionSchema);
