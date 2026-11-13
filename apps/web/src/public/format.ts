/**
 * Display helpers for the public site. Amounts arrive as integer minor units
 * from the API; this only formats them, it never does price arithmetic.
 */
import { formatMinor } from '@marafiq/shared';

export type Currency = 'PKR' | 'SAR';

/** "PKR 242,400" / "SAR 442.80": decimals only when there are halalas. */
export function money(currency: Currency, minor: number): string {
  return `${currency} ${formatMinor(minor, { decimals: minor % 100 !== 0 })}`;
}

const locale = (language: string) => (language === 'ur' ? 'ur-PK' : 'en-GB');

/** A calendar date ("2027-02-08") shown as written, with no time-zone shift. */
export function formatDay(date: string, language: string): string {
  return new Intl.DateTimeFormat(locale(language), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
    numberingSystem: 'latn',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** A moment shown in Pakistan time, where customers are. */
export function formatMoment(at: string | Date, language: string): string {
  return new Intl.DateTimeFormat(locale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
    numberingSystem: 'latn',
  }).format(new Date(at));
}

/** Today in Pakistan, as the API checks the arrival date the same way. */
export function todayInPakistan(at: Date = new Date()): string {
  return new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Keep a left-to-right run (an amount, "1 SAR = PKR 75.00", a supplier name)
 * in its own order inside an Urdu sentence. Unicode isolates; English is untouched.
 */
export function ltr(text: string, language: string): string {
  return language === 'ur' ? `⁦${text}⁩` : text;
}
