import type { AuditQuery, Paged, Role } from '@marafiq/shared';
import { AuditEventModel } from './audit.model.js';

export type ActorRole = Role | 'public' | 'system';

export interface AuditInput {
  actor: { id?: string; role: ActorRole };
  /** Dotted name, e.g. "user.create", "auth.login_failure". */
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

const SECRET_KEY = /pass|token|secret|hash|totp/i;

/**
 * Remove anything that looks like a credential, at any depth. Callers should
 * already pass safe data; this is the last line of defence.
 */
export function sanitizeAuditData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditData);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, child]) => [key, sanitizeAuditData(child)]),
  );
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await AuditEventModel.create({
    actorId: input.actor.id,
    actorRole: input.actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before === undefined ? undefined : sanitizeAuditData(input.before),
    after: input.after === undefined ? undefined : sanitizeAuditData(input.after),
    ip: input.ip,
    at: new Date(),
  });
}

export interface AuditEventView {
  id: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  ip: string | null;
  at: Date;
}

export async function listAudit(query: AuditQuery): Promise<Paged<AuditEventView>> {
  const filter: Record<string, unknown> = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.actorId) filter.actorId = query.actorId;
  if (query.action) filter.action = query.action;
  if (query.from || query.to) {
    filter.at = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  const [docs, total] = await Promise.all([
    AuditEventModel.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    AuditEventModel.countDocuments(filter),
  ]);

  return {
    items: docs.map((doc) => ({
      id: String(doc._id),
      actorId: doc.actorId ? String(doc.actorId) : null,
      actorRole: doc.actorRole,
      action: doc.action,
      entityType: doc.entityType,
      entityId: doc.entityId ? String(doc.entityId) : null,
      before: doc.before ?? undefined,
      after: doc.after ?? undefined,
      ip: doc.ip ?? null,
      at: doc.at,
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}
