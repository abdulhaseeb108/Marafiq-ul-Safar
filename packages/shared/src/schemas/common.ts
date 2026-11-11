import { z } from 'zod';

/** Mongo ObjectId as a 24-character hex string. */
export const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/** UTC timestamp. Accepts Date or ISO string, outputs Date. */
export const timestamp = z.coerce.date();

/**
 * Calendar date with no time zone, "YYYY-MM-DD". Used for hotel nights, pack
 * dates and sheet issue dates so a night never shifts across time zones.
 */
export const isoDate = z.iso.date();

/** Integer minor units (SAR halalas / PKR paisa), zero or more. */
export const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Integer minor units, strictly greater than zero (a real price). */
export const positiveMinor = minor.positive();

/** Decimal string with up to 4 places, greater than zero, e.g. "74.50". */
export const fxRateString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Use a decimal string such as "74.50"')
  .refine((value) => Number(value) > 0, 'FX rate must be greater than zero');

export const currency = z.enum(['SAR', 'PKR']);

/** Fields every collection has. */
export const baseDoc = {
  _id: objectId,
  createdAt: timestamp,
  updatedAt: timestamp,
};

export const fxSnapshot = z.object({ rate: fxRateString, effectiveAt: timestamp });
