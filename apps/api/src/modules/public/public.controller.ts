import { LANGUAGES, type PublicConfig } from '@marafiq/shared';
import type { Request, Response } from 'express';
import { activeDepartureCities } from '../flight-estimates/flight-estimates.service.js';
import { getCurrentFx } from '../fx/fx.service.js';
import { getSettings } from '../settings/settings.service.js';

/**
 * Everything the public site needs before it can show anything.
 * Built field by field on purpose: no database document is spread into the
 * response, so supplier contacts, internal notes and the markup percentage
 * cannot leak. The markup is a flag only.
 */
export async function getConfig(_req: Request, res: Response<PublicConfig>): Promise<void> {
  const [settings, fx, departureCities] = await Promise.all([
    getSettings(),
    getCurrentFx(),
    activeDepartureCities(),
  ]);

  res.json({
    languages: [...LANGUAGES],
    fx: fx ? { rate: fx.rate, effectiveAt: fx.effectiveAt } : null,
    markupApplied: settings.markupPercent > 0,
    showSupplierRates: settings.showSupplierRates,
    responseTimeText: settings.responseTimeText,
    departureCities,
  });
}
