import {
  CalculateInputSchema,
  LANGUAGES,
  PublicHotelsQuerySchema,
  type CalculationResult,
  type PublicConfig,
  type PublicHotel,
} from '@marafiq/shared';
import type { Request, Response } from 'express';
import { activeDepartureCities } from '../flight-estimates/flight-estimates.service.js';
import { getCurrentFx } from '../fx/fx.service.js';
import { parseOrThrow } from '../../lib/validate.js';
import { calculateNow, listPublicHotels } from '../pricing/pricing.service.js';
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

/** POST /public/calculate: a calculation for these inputs. Not saved. */
export async function postCalculate(req: Request, res: Response<CalculationResult>): Promise<void> {
  const input = parseOrThrow(CalculateInputSchema, req.body);
  res.json(await calculateNow(input));
}

/** GET /public/hotels?city= : hotels the calculator can offer, with "from" prices. */
export async function getHotels(
  req: Request,
  res: Response<{ items: PublicHotel[] }>,
): Promise<void> {
  const { city } = parseOrThrow(PublicHotelsQuerySchema, req.query);
  res.json({ items: await listPublicHotels(city) });
}
