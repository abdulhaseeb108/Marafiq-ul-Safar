/**
 * Staff quote arithmetic (docs/01 section 7). Each line is quantity x unit in
 * its own currency; the other currency comes from the quote's stored FX rate.
 * SAR -> PKR rounds to whole rupees per line (as the calculator does);
 * PKR -> SAR rounds half up to the halala. Totals are sums of the lines.
 */
import {
  convertPkrToSarMinor,
  convertSarToPkrWholeRupeesMinor,
  parseFxRate,
  sumMinor,
} from './money.js';

export interface QuoteLineInput {
  quantity: number;
  unitAmountMinor: number;
  currency: 'SAR' | 'PKR';
}

export interface QuoteLineAmounts {
  /** quantity x unit, in the line's own currency. */
  amountMinor: number;
  amountMinorSAR: number;
  amountMinorPKR: number;
}

export interface QuoteTotals {
  totalMinorPKR: number;
  totalMinorSAR: number;
}

export function quoteLineAmounts(line: QuoteLineInput, fxRate: string): QuoteLineAmounts {
  const rate = parseFxRate(fxRate);
  const amountMinor = line.quantity * line.unitAmountMinor;
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('Line amount is too large');
  return line.currency === 'SAR'
    ? {
        amountMinor,
        amountMinorSAR: amountMinor,
        amountMinorPKR: convertSarToPkrWholeRupeesMinor(amountMinor, rate),
      }
    : {
        amountMinor,
        amountMinorSAR: convertPkrToSarMinor(amountMinor, rate),
        amountMinorPKR: amountMinor,
      };
}

export function quoteTotals(lines: readonly QuoteLineInput[], fxRate: string): QuoteTotals {
  const amounts = lines.map((line) => quoteLineAmounts(line, fxRate));
  return {
    totalMinorPKR: sumMinor(amounts.map((a) => a.amountMinorPKR)),
    totalMinorSAR: sumMinor(amounts.map((a) => a.amountMinorSAR)),
  };
}
