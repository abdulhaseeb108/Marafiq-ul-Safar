/**
 * Money helpers. The ONLY place money arithmetic happens (CLAUDE.md hard rule 1).
 *
 * - Every amount is an integer in minor units: SAR halalas or PKR paisa (x100).
 * - No floating point: intermediate products use BigInt, inputs are checked.
 * - Rounding rules (docs/03 section 5), one function each, never mixed:
 *     per-person rates and per-person totals -> ceil to a whole SAR / rupee
 *     markup                                  -> ceil to the halala, before FX
 *     SAR -> PKR                              -> half up
 *     totals                                  -> sum of the rounded line items
 */

export type Currency = 'SAR' | 'PKR';

export const MINOR_PER_MAJOR = 100;
/** FX rates are integers scaled by 10,000 ("74.50" -> 745000). */
export const FX_SCALE = 10_000;
/** Markup is held in basis points (1% = 100 bps). */
export const BPS_SCALE = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(`${label} must be a non-negative integer, got ${String(value)}`);
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyError(`${label} must be a positive integer, got ${String(value)}`);
  }
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('amount exceeds the safe integer range');
  }
  return Number(value);
}

const ceilDivBig = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;
const halfUpDivBig = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);

/** Parse a non-negative decimal string into an integer scaled by 10^decimals. */
export function parseDecimalScaled(value: string, decimals: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new MoneyError(`not a non-negative decimal: "${value}"`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw new MoneyError(`"${value}" has more than ${decimals} decimal places`);
  }
  return toSafeNumber(BigInt(whole + fraction.padEnd(decimals, '0')));
}

/** Whole SAR / PKR -> halalas / paisa. Supplier sheets print whole SAR. */
export function majorToMinor(major: number): number {
  assertNonNegativeInt(major, 'major amount');
  return toSafeNumber(BigInt(major) * BigInt(MINOR_PER_MAJOR));
}

/** "12.50" -> 1250. Use for amounts typed by staff. */
export function parseMajorToMinor(value: string): number {
  return parseDecimalScaled(value, 2);
}

export function sumMinor(amounts: readonly number[]): number {
  let total = 0n;
  for (const amount of amounts) {
    assertNonNegativeInt(amount, 'amount');
    total += BigInt(amount);
  }
  return toSafeNumber(total);
}

/** Integer division rounding any remainder up. */
export function ceilDiv(numerator: number, divisor: number): number {
  assertNonNegativeInt(numerator, 'numerator');
  assertPositiveInt(divisor, 'divisor');
  return toSafeNumber(ceilDivBig(BigInt(numerator), BigInt(divisor)));
}

/** Integer division rounding half up (0.5 -> 1). */
export function roundHalfUpDiv(numerator: number, divisor: number): number {
  assertNonNegativeInt(numerator, 'numerator');
  assertPositiveInt(divisor, 'divisor');
  return toSafeNumber(halfUpDivBig(BigInt(numerator), BigInt(divisor)));
}

/**
 * Split an amount between persons, rounding UP to a whole major unit.
 * Used for the derived per-person room rate (room SAR 200 / 3 -> SAR 67) and
 * for the per-person total (group PKR total / persons).
 */
export function perPersonCeilMinor(totalMinor: number, persons: number): number {
  assertNonNegativeInt(totalMinor, 'totalMinor');
  assertPositiveInt(persons, 'persons');
  const wholeMajor = ceilDivBig(BigInt(totalMinor), BigInt(persons) * BigInt(MINOR_PER_MAJOR));
  return toSafeNumber(wholeMajor * BigInt(MINOR_PER_MAJOR));
}

/** Round a minor amount half up to a whole major unit (still in minor units). */
export function roundToWholeMajorMinor(minor: number): number {
  return roundHalfUpDiv(minor, MINOR_PER_MAJOR) * MINOR_PER_MAJOR;
}

/** "74.50" -> 745000. Up to 4 decimal places; must be greater than zero. */
export function parseFxRate(rate: string): number {
  const scaled = parseDecimalScaled(rate, 4);
  if (scaled <= 0) throw new MoneyError('FX rate must be greater than zero');
  return scaled;
}

/** pkrMinor = round(sarMinor x rateScaled / 10,000), half up, paisa precision. */
export function convertSarToPkrMinor(sarMinor: number, rateScaled: number): number {
  assertNonNegativeInt(sarMinor, 'sarMinor');
  assertPositiveInt(rateScaled, 'rateScaled');
  return toSafeNumber(halfUpDivBig(BigInt(sarMinor) * BigInt(rateScaled), BigInt(FX_SCALE)));
}

/**
 * SAR line item -> displayed PKR, rounded half up to whole rupees (returned in
 * paisa). Rounds once from the exact product so paisa rounding cannot push a
 * value across the .50 boundary. Totals must be the sum of these line values.
 */
export function convertSarToPkrWholeRupeesMinor(sarMinor: number, rateScaled: number): number {
  assertNonNegativeInt(sarMinor, 'sarMinor');
  assertPositiveInt(rateScaled, 'rateScaled');
  const rupees = halfUpDivBig(
    BigInt(sarMinor) * BigInt(rateScaled),
    BigInt(FX_SCALE) * BigInt(MINOR_PER_MAJOR),
  );
  return toSafeNumber(rupees * BigInt(MINOR_PER_MAJOR));
}

/** Settings store markup as a percent (e.g. 2.5); convert to basis points. */
export function markupPercentToBps(percent: number | string): number {
  if (typeof percent === 'number' && !(percent >= 0)) {
    throw new MoneyError(`markup percent must be zero or more, got ${String(percent)}`);
  }
  return parseDecimalScaled(String(percent), 2);
}

/** Apply markup to a SAR line amount, ceil to the halala, before FX. */
export function applyMarkupCeil(sarMinor: number, markupBps: number): number {
  assertNonNegativeInt(sarMinor, 'sarMinor');
  assertNonNegativeInt(markupBps, 'markupBps');
  const scale = BigInt(BPS_SCALE);
  return toSafeNumber(ceilDivBig(BigInt(sarMinor) * (scale + BigInt(markupBps)), scale));
}

/** 24240000 -> "242,400"; with decimals: 123456 -> "1,234.56". Display only. */
export function formatMinor(minor: number, options: { decimals?: boolean } = {}): string {
  assertNonNegativeInt(minor, 'minor');
  const whole = Math.trunc(minor / MINOR_PER_MAJOR);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (!options.decimals) return grouped;
  return `${grouped}.${String(minor % MINOR_PER_MAJOR).padStart(2, '0')}`;
}
