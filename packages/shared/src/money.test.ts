import { describe, expect, it } from 'vitest';
import {
  FX_SCALE,
  MoneyError,
  applyMarkupCeil,
  ceilDiv,
  convertSarToPkrMinor,
  convertSarToPkrWholeRupeesMinor,
  formatMinor,
  majorToMinor,
  markupPercentToBps,
  parseFxRate,
  parseMajorToMinor,
  perPersonCeilMinor,
  roundHalfUpDiv,
  roundToWholeMajorMinor,
  sumMinor,
} from './money.js';

describe('minor-unit helpers', () => {
  it('converts whole SAR / PKR to halalas / paisa', () => {
    expect(majorToMinor(550)).toBe(55_000);
    expect(majorToMinor(0)).toBe(0);
  });

  it('parses decimal strings without floating point', () => {
    expect(parseMajorToMinor('12.5')).toBe(1250);
    expect(parseMajorToMinor('0.07')).toBe(7);
    expect(parseMajorToMinor('200')).toBe(20_000);
  });

  it('rejects floats, negatives and malformed input', () => {
    expect(() => majorToMinor(12.5)).toThrow(MoneyError);
    expect(() => majorToMinor(-1)).toThrow(MoneyError);
    expect(() => parseMajorToMinor('12.345')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('-3')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('abc')).toThrow(MoneyError);
    expect(() => sumMinor([1, 0.5])).toThrow(MoneyError);
  });

  it('sums minor amounts', () => {
    expect(sumMinor([])).toBe(0);
    expect(sumMinor([60_000, 43_200, 220_000])).toBe(323_200);
  });

  it('formats for display', () => {
    expect(formatMinor(24_240_000)).toBe('242,400');
    expect(formatMinor(123_456, { decimals: true })).toBe('1,234.56');
    expect(formatMinor(5, { decimals: true })).toBe('0.05');
  });
});

describe('ceil division', () => {
  it('rounds up any remainder', () => {
    expect(ceilDiv(10, 2)).toBe(5);
    expect(ceilDiv(10, 3)).toBe(4);
    expect(ceilDiv(0, 3)).toBe(0);
    expect(ceilDiv(1, 3)).toBe(1);
  });

  it('rejects zero or negative divisors and negative amounts', () => {
    expect(() => ceilDiv(10, 0)).toThrow(MoneyError);
    expect(() => ceilDiv(10, -2)).toThrow(MoneyError);
    expect(() => ceilDiv(-10, 2)).toThrow(MoneyError);
  });
});

describe('half-up rounding', () => {
  it('rounds .5 up and below .5 down', () => {
    expect(roundHalfUpDiv(5, 10)).toBe(1);
    expect(roundHalfUpDiv(4, 10)).toBe(0);
    expect(roundHalfUpDiv(15, 10)).toBe(2);
    expect(roundHalfUpDiv(25, 10)).toBe(3); // not banker's rounding
  });

  it('rounds paisa to whole rupees', () => {
    expect(roundToWholeMajorMinor(499_150)).toBe(499_200);
    expect(roundToWholeMajorMinor(499_149)).toBe(499_100);
  });
});

describe('FX rate parsing (scaled by 10,000)', () => {
  it('parses decimal strings', () => {
    expect(FX_SCALE).toBe(10_000);
    expect(parseFxRate('75.00')).toBe(750_000);
    expect(parseFxRate('74.50')).toBe(745_000);
    expect(parseFxRate('74.1234')).toBe(741_234);
  });

  it('rejects zero, negatives and more than 4 decimals', () => {
    expect(() => parseFxRate('0')).toThrow(MoneyError);
    expect(() => parseFxRate('-75')).toThrow(MoneyError);
    expect(() => parseFxRate('74.12345')).toThrow(MoneyError);
  });
});

describe('markup', () => {
  it('0% leaves the supplier price untouched', () => {
    expect(applyMarkupCeil(20_000, markupPercentToBps(0))).toBe(20_000);
  });

  it('applies with ceil before FX', () => {
    expect(markupPercentToBps(2.5)).toBe(250);
    // 66.67 SAR + 2.5% = 68.33675 -> 68.34
    expect(applyMarkupCeil(6667, 250)).toBe(6834);
    expect(applyMarkupCeil(20_000, 1000)).toBe(22_000);
  });

  it('rejects negative markup and more than 2 decimals', () => {
    expect(() => markupPercentToBps(-1)).toThrow(MoneyError);
    expect(() => markupPercentToBps('2.555')).toThrow(MoneyError);
  });
});

/**
 * T8 from docs/03-RATE-SHEET-INGESTION-AND-PRICING.md section 7:
 * "Money: 66.666… rounding — per-person derived check uses ceil; PKR
 * conversion rounds half up; totals equal sum of rounded lines."
 */
describe('T8: 66.666… rounding', () => {
  const room200 = majorToMinor(200);

  it('per-person derived rate uses ceil to whole SAR (Qila Ajiyad, room 200)', () => {
    // docs/03 section 1: room 200 -> 40 / 50 / 67 / 100
    expect(perPersonCeilMinor(room200, 5)).toBe(majorToMinor(40));
    expect(perPersonCeilMinor(room200, 4)).toBe(majorToMinor(50));
    expect(perPersonCeilMinor(room200, 3)).toBe(majorToMinor(67)); // 66.666… -> 67
    expect(perPersonCeilMinor(room200, 2)).toBe(majorToMinor(100));
  });

  it('ceil also covers .5 (T4: room 95 double -> 48)', () => {
    expect(perPersonCeilMinor(majorToMinor(95), 2)).toBe(majorToMinor(48));
  });

  it('PKR conversion rounds half up at paisa precision', () => {
    const rate = parseFxRate('74.50');
    // 0.01 SAR x 74.50 = 0.745 PKR = 74.5 paisa -> 75
    expect(convertSarToPkrMinor(1, rate)).toBe(75);
    // 0.02 SAR x 74.50 = 149 paisa exactly
    expect(convertSarToPkrMinor(2, rate)).toBe(149);
  });

  it('displayed PKR line rounds half up to whole rupees', () => {
    const rate = parseFxRate('74.50');
    // SAR 67 x 74.50 = PKR 4,991.50 -> 4,992
    expect(convertSarToPkrWholeRupeesMinor(majorToMinor(67), rate)).toBe(majorToMinor(4992));
  });

  it('rounds once from the exact value, never twice', () => {
    // SAR 1 x 0.4995 = PKR 0.4995 -> 0 (paisa-then-rupee rounding would give 1)
    expect(convertSarToPkrWholeRupeesMinor(100, parseFxRate('0.4995'))).toBe(0);
  });

  it('totals equal the sum of rounded lines, not the rounded total', () => {
    const rate = parseFxRate('74.50');
    const lineSar = perPersonCeilMinor(room200, 3); // SAR 67
    const lines = [lineSar, lineSar, lineSar].map((l) => convertSarToPkrWholeRupeesMinor(l, rate));
    const total = sumMinor(lines);
    expect(total).toBe(majorToMinor(14_976)); // 3 x 4,992
    // Converting the SAR total in one go would give 14,975 (201 x 74.5 = 14,974.5)
    expect(convertSarToPkrWholeRupeesMinor(sumMinor([lineSar, lineSar, lineSar]), rate)).toBe(
      majorToMinor(14_975),
    );
  });

  it('matches T1 totals at FX 75.00 (SAR 3,232 -> PKR 242,400; SAR 808 per person)', () => {
    const rate = parseFxRate('75.00');
    const linesSar = [majorToMinor(600), majorToMinor(432), majorToMinor(2200)];
    const totalSar = sumMinor(linesSar);
    expect(totalSar).toBe(majorToMinor(3232));
    expect(perPersonCeilMinor(totalSar, 4)).toBe(majorToMinor(808));
    const totalPkr = sumMinor(linesSar.map((l) => convertSarToPkrWholeRupeesMinor(l, rate)));
    expect(totalPkr).toBe(majorToMinor(242_400));
  });
});

describe('properties', () => {
  it('conversion is never negative and is monotonic in the amount', () => {
    const rate = parseFxRate('74.37');
    let prev = 0;
    for (let sar = 0; sar <= 50_000; sar += 137) {
      const pkr = convertSarToPkrMinor(sar, rate);
      expect(pkr).toBeGreaterThanOrEqual(prev);
      prev = pkr;
    }
  });

  it('per-person x persons always covers the total', () => {
    for (let total = 0; total <= 100_000; total += 333) {
      for (const persons of [1, 2, 3, 4, 5, 7]) {
        expect(perPersonCeilMinor(total, persons) * persons).toBeGreaterThanOrEqual(total);
      }
    }
  });
});
