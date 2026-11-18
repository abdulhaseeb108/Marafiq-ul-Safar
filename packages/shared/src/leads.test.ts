import { describe, expect, it } from 'vitest';
import { convertPkrToSarMinor, parseFxRate } from './money.js';
import { formatPkMobile, normalizePkMobile } from './phone.js';
import { quoteLineAmounts, quoteTotals } from './quote.js';
import { CONSENT_TEXT_VERSION, InquiryBodySchema, UpdateQuoteBodySchema } from './schemas/leads.js';
import {
  CUSTOMER_QUOTE_STATUS_WORDING,
  QUOTE_STATUSES,
  customerQuoteStatusLabel,
} from './status.js';

describe('Pakistani mobile numbers', () => {
  it.each([
    '03001234567',
    '0300 1234567',
    '0300-1234567',
    '+92 300 1234567',
    '+923001234567',
    '923001234567',
    '00923001234567',
    '3001234567',
    '(0300) 123-4567',
  ])('%s -> +923001234567', (input) => {
    expect(normalizePkMobile(input)).toBe('+923001234567');
  });

  it.each([
    '',
    '0300123456',
    '030012345678',
    '0423 1234567',
    '+44 7700 900123',
    'abc',
    '0300 12345x7',
  ])('rejects %j', (input) => {
    expect(normalizePkMobile(input)).toBeNull();
  });

  it('formats for display the Pakistani way', () => {
    expect(formatPkMobile('+923001234567')).toBe('0300 1234567');
  });
});

describe('PKR -> SAR', () => {
  it('rounds half up to the halala', () => {
    // PKR 100.00 / 75 = SAR 1.3333 -> 1.33; PKR 112.50 / 75 = SAR 1.50.
    expect(convertPkrToSarMinor(10_000, parseFxRate('75'))).toBe(133);
    expect(convertPkrToSarMinor(11_250, parseFxRate('75'))).toBe(150);
    // PKR 1.00 / 74.99 = 0.013335... -> 0.01
    expect(convertPkrToSarMinor(100, parseFxRate('74.99'))).toBe(1);
  });
});

describe('quote totals', () => {
  it('SAR lines give whole-rupee PKR; PKR lines give halala SAR; totals are line sums', () => {
    const lines = [
      { quantity: 12, unitAmountMinor: 5_000, currency: 'SAR' as const }, // SAR 600
      { quantity: 4, unitAmountMinor: 55_000, currency: 'SAR' as const }, // SAR 2,200
      { quantity: 4, unitAmountMinor: 18_000_000, currency: 'PKR' as const }, // PKR 720,000
    ];
    expect(quoteLineAmounts(lines[0]!, '75.00')).toEqual({
      amountMinor: 60_000,
      amountMinorSAR: 60_000,
      amountMinorPKR: 4_500_000,
    });
    expect(quoteLineAmounts(lines[2]!, '75.00').amountMinorSAR).toBe(960_000);
    expect(quoteTotals(lines, '75.00')).toEqual({
      totalMinorPKR: 4_500_000 + 16_500_000 + 72_000_000,
      totalMinorSAR: 60_000 + 220_000 + 960_000,
    });
  });

  it('a quote with no lines totals zero', () => {
    expect(quoteTotals([], '75.00')).toEqual({ totalMinorPKR: 0, totalMinorSAR: 0 });
  });
});

describe('inquiry body', () => {
  const valid = {
    source: 'umrah',
    traveler: { name: ' Aisha Khan ', phone: '0300 1234567', email: '', language: 'ur' },
    consent: { accepted: true, textVersion: CONSENT_TEXT_VERSION },
  };

  it('normalizes the phone, drops an empty email and trims the name', () => {
    const parsed = InquiryBodySchema.parse(valid);
    expect(parsed.traveler).toEqual({
      name: 'Aisha Khan',
      phone: '+923001234567',
      email: undefined,
      language: 'ur',
    });
    expect(parsed.notes).toBe('');
  });

  it('drops fields we must never collect', () => {
    const parsed = InquiryBodySchema.parse({
      ...valid,
      passportNumber: 'AB1234567',
      traveler: { ...valid.traveler, cnic: '12345-1234567-1', card: '4111111111111111' },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/AB1234567|12345-1234567-1|4111111111111111/);
  });

  it('requires consent to the current text version', () => {
    expect(
      InquiryBodySchema.safeParse({
        ...valid,
        consent: { accepted: false, textVersion: CONSENT_TEXT_VERSION },
      }).success,
    ).toBe(false);
    expect(
      InquiryBodySchema.safeParse({ ...valid, consent: { accepted: true, textVersion: 'old' } })
        .success,
    ).toBe(false);
  });

  it('rejects a phone that is not a Pakistani mobile', () => {
    const result = InquiryBodySchema.safeParse({
      ...valid,
      traveler: { ...valid.traveler, phone: '042 1234567' },
    });
    expect(result.success).toBe(false);
  });
});

describe('quote body', () => {
  it('needs whole minor units and a date for expiry', () => {
    const body = {
      lineItems: [
        {
          description: 'Hotel',
          supplier: 'WMT',
          quantity: 1,
          unitAmountMinor: 10.5,
          currency: 'SAR',
        },
      ],
      exclusions: [],
      terms: '',
      expiresOn: '2027-01-31',
    };
    expect(UpdateQuoteBodySchema.safeParse(body).success).toBe(false);
    body.lineItems[0]!.unitAmountMinor = 1050;
    expect(UpdateQuoteBodySchema.parse(body).lineItems[0]?.notes).toBe('');
  });
});

describe('customer wording', () => {
  it('has a label for every status a customer can see, in both languages, never "booked"', () => {
    for (const language of ['en', 'ur'] as const) {
      for (const status of QUOTE_STATUSES) {
        const label = customerQuoteStatusLabel(status, language);
        if (status === 'draft') expect(label).toBeNull();
        else expect(label).toBe(CUSTOMER_QUOTE_STATUS_WORDING[language][status]);
      }
    }
    expect(JSON.stringify(CUSTOMER_QUOTE_STATUS_WORDING).toLowerCase()).not.toMatch(
      /\bbooked\b|\bconfirmed\b/,
    );
  });
});
