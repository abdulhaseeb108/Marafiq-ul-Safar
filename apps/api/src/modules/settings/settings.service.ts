import type { SettingsView, UpdateSettingsBody } from '@marafiq/shared';
import { recordAudit, type Actor } from '../audit/audit.service.js';
import { SettingsModel, type SettingsDoc } from './settings.model.js';

export function toSettingsView(doc: SettingsDoc): SettingsView {
  return {
    markupPercent: doc.markupPercent,
    estimateExpiryHours: doc.estimateExpiryHours,
    responseTimeText: doc.responseTimeText,
    infantHotelCharge: 'none',
    childAsAdult: doc.childAsAdult,
    showSupplierRates: doc.showSupplierRates,
    updatedAt: doc.updatedAt,
  };
}

/**
 * The single settings document, created with the defaults from docs/02 and
 * docs/05 the first time anything asks for it.
 */
export async function getSettingsDoc(): Promise<SettingsDoc> {
  const existing = await SettingsModel.findOne({ singleton: 'settings' });
  if (existing) return existing;
  try {
    return await SettingsModel.create({ singleton: 'settings' });
  } catch (error) {
    // Another request created it first; use theirs.
    if ((error as { code?: number }).code === 11000) {
      const doc = await SettingsModel.findOne({ singleton: 'settings' });
      if (doc) return doc;
    }
    throw error;
  }
}

export async function getSettings(): Promise<SettingsView> {
  return toSettingsView(await getSettingsDoc());
}

export async function updateSettings(
  body: UpdateSettingsBody,
  actor: Actor,
): Promise<SettingsView> {
  const doc = await getSettingsDoc();
  const before = toSettingsView(doc);

  if (body.markupPercent !== undefined) doc.markupPercent = body.markupPercent;
  if (body.estimateExpiryHours !== undefined) doc.estimateExpiryHours = body.estimateExpiryHours;
  if (body.responseTimeText !== undefined) doc.responseTimeText = body.responseTimeText;
  if (body.infantHotelCharge !== undefined) doc.infantHotelCharge = body.infantHotelCharge;
  if (body.childAsAdult !== undefined) doc.childAsAdult = body.childAsAdult;
  if (body.showSupplierRates !== undefined) doc.showSupplierRates = body.showSupplierRates;
  await doc.save();

  await recordAudit({
    actor,
    action: 'settings.update',
    entityType: 'settings',
    entityId: doc.id as string,
    before,
    after: toSettingsView(doc),
    ip: actor.ip,
  });
  return toSettingsView(doc);
}
