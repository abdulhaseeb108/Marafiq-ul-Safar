import type {
  CreateSupplierBody,
  ListQuery,
  Paged,
  SupplierType,
  SupplierView,
  UpdateSupplierBody,
} from '@marafiq/shared';
import mongoose from 'mongoose';
import { HttpError, notFound } from '../../lib/http-error.js';
import { normalizeName } from '../../lib/names.js';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { SupplierModel, type SupplierDoc } from './supplier.model.js';

export function toSupplierView(doc: SupplierDoc): SupplierView {
  return {
    id: doc.id as string,
    name: doc.name,
    type: doc.type as SupplierType,
    contactName: doc.contactName ?? null,
    phone: doc.phone ?? null,
    email: doc.email ?? null,
    notes: doc.notes ?? null,
    active: doc.active,
    createdAt: doc.createdAt,
  };
}

/** What audit events record: the whole supplier, which holds nothing secret. */
const snapshot = (doc: SupplierDoc) => {
  const { id: _id, createdAt: _createdAt, ...rest } = toSupplierView(doc);
  return rest;
};

const nameTaken = () =>
  new HttpError(409, 'supplier_name_taken', 'A supplier with this name already exists');

async function findOr404(id: string): Promise<SupplierDoc> {
  const doc = mongoose.isValidObjectId(id) ? await SupplierModel.findById(id) : null;
  if (!doc) throw notFound('Supplier');
  return doc;
}

/** "" clears an optional field; undefined leaves it alone. */
function applyOptional(
  doc: SupplierDoc,
  key: 'contactName' | 'phone' | 'email' | 'notes',
  value?: string,
) {
  if (value === undefined) return;
  doc[key] = value === '' ? undefined : value;
}

export async function createSupplier(
  body: CreateSupplierBody,
  actor: Actor,
): Promise<SupplierView> {
  const searchName = normalizeName(body.name);
  if (await SupplierModel.exists({ searchName })) throw nameTaken();
  let doc: SupplierDoc;
  try {
    doc = await SupplierModel.create({
      name: body.name,
      searchName,
      type: body.type,
      contactName: body.contactName || undefined,
      phone: body.phone || undefined,
      email: body.email || undefined,
      notes: body.notes || undefined,
      active: true,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw nameTaken();
    throw error;
  }
  await recordAudit({
    actor,
    action: 'supplier.create',
    entityType: 'supplier',
    entityId: doc.id as string,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toSupplierView(doc);
}

export async function listSuppliers(query: ListQuery): Promise<Paged<SupplierView>> {
  const [docs, total] = await Promise.all([
    SupplierModel.find()
      .sort({ name: 1, _id: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SupplierModel.countDocuments(),
  ]);
  return { items: docs.map(toSupplierView), page: query.page, limit: query.limit, total };
}

export async function getSupplier(id: string): Promise<SupplierView> {
  return toSupplierView(await findOr404(id));
}

export async function updateSupplier(
  id: string,
  body: UpdateSupplierBody,
  actor: Actor,
): Promise<SupplierView> {
  const doc = await findOr404(id);
  const before = snapshot(doc);

  if (body.name !== undefined) {
    const searchName = normalizeName(body.name);
    const clash = await SupplierModel.exists({ searchName, _id: { $ne: doc._id } });
    if (clash) throw nameTaken();
    doc.name = body.name;
    doc.searchName = searchName;
  }
  if (body.type !== undefined) doc.type = body.type;
  if (body.active !== undefined) doc.active = body.active;
  applyOptional(doc, 'contactName', body.contactName);
  applyOptional(doc, 'phone', body.phone);
  applyOptional(doc, 'email', body.email);
  applyOptional(doc, 'notes', body.notes);
  await doc.save();

  let action = 'supplier.update';
  if (body.active !== undefined && body.active !== before.active) {
    action = body.active ? 'supplier.reactivate' : 'supplier.deactivate';
  }
  await recordAudit({
    actor,
    action,
    entityType: 'supplier',
    entityId: doc.id as string,
    before,
    after: snapshot(doc),
    ip: actor.ip,
  });
  return toSupplierView(doc);
}

/** Suppliers are never deleted: rate sheets and quotes keep pointing at them. */
export function deactivateSupplier(id: string, actor: Actor): Promise<SupplierView> {
  return updateSupplier(id, { active: false }, actor);
}
