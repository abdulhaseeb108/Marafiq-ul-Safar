import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_QUOTE_STATUS_WORDING,
  LANGUAGES,
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  QUOTE_STATUSES,
  QUOTE_TRANSITIONS,
  RATE_PACKAGE_STATUSES,
  RATE_PACKAGE_TRANSITIONS,
  StatusTransitionError,
  assertTransition,
  canTransition,
  customerQuoteStatusLabel,
} from './status.js';

function allowedPairs<S extends string>(table: Record<S, readonly S[]>): string[] {
  return (Object.keys(table) as S[]).flatMap((from) => table[from].map((to) => `${from}>${to}`));
}

describe('rate package transitions', () => {
  it('allows exactly the transitions in docs/02 section 2', () => {
    expect(allowedPairs(RATE_PACKAGE_TRANSITIONS).sort()).toEqual(
      [
        'draft>needs_review',
        'draft>rejected',
        'needs_review>published',
        'needs_review>rejected',
        'published>superseded',
      ].sort(),
    );
  });

  it('never lets a draft be published without review (hard rule 5)', () => {
    expect(canTransition(RATE_PACKAGE_TRANSITIONS, 'draft', 'published')).toBe(false);
  });

  it('has a row for every status', () => {
    expect(Object.keys(RATE_PACKAGE_TRANSITIONS).sort()).toEqual([...RATE_PACKAGE_STATUSES].sort());
  });
});

describe('lead transitions', () => {
  it('follows the pipeline in order', () => {
    expect(canTransition(LEAD_TRANSITIONS, 'new', 'contacted')).toBe(true);
    expect(canTransition(LEAD_TRANSITIONS, 'contacted', 'quote_in_progress')).toBe(true);
    expect(canTransition(LEAD_TRANSITIONS, 'quote_in_progress', 'quote_sent')).toBe(true);
    expect(canTransition(LEAD_TRANSITIONS, 'quote_sent', 'accepted')).toBe(true);
    expect(canTransition(LEAD_TRANSITIONS, 'quote_sent', 'declined')).toBe(true);
  });

  it('does not allow skipping steps or going backwards', () => {
    expect(canTransition(LEAD_TRANSITIONS, 'new', 'quote_sent')).toBe(false);
    expect(canTransition(LEAD_TRANSITIONS, 'new', 'accepted')).toBe(false);
    expect(canTransition(LEAD_TRANSITIONS, 'contacted', 'new')).toBe(false);
  });

  it('any status except lost can move to lost', () => {
    for (const from of LEAD_STATUSES) {
      expect(canTransition(LEAD_TRANSITIONS, from, 'lost')).toBe(from !== 'lost');
    }
    expect(LEAD_TRANSITIONS.lost).toEqual([]);
  });
});

describe('quote transitions', () => {
  it('allows exactly the transitions in docs/02 section 2', () => {
    expect(allowedPairs(QUOTE_TRANSITIONS).sort()).toEqual(
      ['draft>sent', 'sent>accepted', 'sent>declined', 'sent>expired', 'sent>replaced'].sort(),
    );
  });

  it('cannot accept a draft or revive an expired quote', () => {
    expect(canTransition(QUOTE_TRANSITIONS, 'draft', 'accepted')).toBe(false);
    expect(canTransition(QUOTE_TRANSITIONS, 'expired', 'sent')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('passes for allowed and throws a typed error for forbidden moves', () => {
    expect(() => assertTransition(QUOTE_TRANSITIONS, 'draft', 'sent')).not.toThrow();
    expect(() => assertTransition(QUOTE_TRANSITIONS, 'sent', 'draft')).toThrow(
      StatusTransitionError,
    );
  });

  it('rejects same-status "transitions"', () => {
    expect(canTransition(QUOTE_TRANSITIONS, 'sent', 'sent')).toBe(false);
  });
});

describe('customer wording map', () => {
  it('uses the exact English wording from docs/02 section 2', () => {
    expect(customerQuoteStatusLabel('sent', 'en')).toBe('Quote sent');
    expect(customerQuoteStatusLabel('accepted', 'en')).toBe(
      'Request accepted — we will confirm with suppliers',
    );
  });

  it('has non-empty English and Urdu wording for every customer-visible status', () => {
    for (const status of QUOTE_STATUSES) {
      if (status === 'draft') continue;
      for (const lang of LANGUAGES) {
        expect(customerQuoteStatusLabel(status, lang)?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never exposes draft to customers', () => {
    expect(customerQuoteStatusLabel('draft', 'en')).toBeNull();
    expect(customerQuoteStatusLabel('draft', 'ur')).toBeNull();
  });

  it('never says "booked" or "confirmed" in either language (hard rule 2)', () => {
    const forbidden = [/book/i, /confirmed/i, /بک/, /بُک/, /کنفرم/, /تصدیق شدہ/];
    for (const perLang of Object.values(CUSTOMER_QUOTE_STATUS_WORDING)) {
      for (const text of Object.values(perLang)) {
        for (const pattern of forbidden) expect(text).not.toMatch(pattern);
      }
    }
  });
});
