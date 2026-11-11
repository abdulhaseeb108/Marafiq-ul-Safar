import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Append-only. Nothing in the code updates or deletes these documents. */
const auditEventSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String },
    at: { type: Date, required: true },
  },
  { collection: 'auditEvents', versionKey: false },
);

auditEventSchema.index({ entityType: 1, entityId: 1, at: -1 });
auditEventSchema.index({ at: -1 });

export type AuditEventDoc = HydratedDocument<InferSchemaType<typeof auditEventSchema>>;
export const AuditEventModel = model('AuditEvent', auditEventSchema);
