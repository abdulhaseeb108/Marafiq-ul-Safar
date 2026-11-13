/**
 * Matching a name printed on a rate sheet to a hotel (docs/03 section 2.4):
 * exact canonical name or alias first; otherwise a close match is *suggested*
 * to staff and never applied automatically.
 */
import { normalizeName } from '../../lib/names.js';
import { HotelModel } from '../hotels/hotel.model.js';

export const SUGGESTION_THRESHOLD = 0.85;

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * 0 to 1. The better of two views of the names: shared words (so word order
 * does not matter) and character edits (so one mistyped letter does not).
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;

  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  const shared = [...xs].filter((token) => ys.has(token)).length;
  const tokenScore = shared / (xs.size + ys.size - shared);

  const editScore = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(tokenScore, editScore);
}

interface IndexedHotel {
  id: string;
  canonicalName: string;
  searchNames: string[];
}

export interface HotelMatch {
  hotelId: string | null;
  /** Offered to staff when there is no exact match. */
  suggestedHotelId: string | null;
}

/**
 * All hotels that can be matched, loaded once per extraction so that reading
 * a 90-row file does not mean 90 database queries. Merged-away hotels hold no
 * names, so they can never match.
 */
export class HotelIndex {
  private constructor(private readonly byCity: Map<string, IndexedHotel[]>) {}

  static async load(): Promise<HotelIndex> {
    const hotels = await HotelModel.find({ mergedIntoId: null })
      .select('city canonicalName searchNames')
      .lean();
    const byCity = new Map<string, IndexedHotel[]>();
    for (const hotel of hotels) {
      const list = byCity.get(hotel.city) ?? [];
      list.push({
        id: String(hotel._id),
        canonicalName: hotel.canonicalName,
        searchNames: hotel.searchNames,
      });
      byCity.set(hotel.city, list);
    }
    return new HotelIndex(byCity);
  }

  match(city: string, printedName: string, printedAliases: readonly string[] = []): HotelMatch {
    const hotels = this.byCity.get(city) ?? [];
    const names = [printedName, ...printedAliases].map(normalizeName);

    // The printed name first, then any "OLD NAME" printed beside it.
    for (const name of names) {
      const exact = hotels.find((hotel) => hotel.searchNames.includes(name));
      if (exact) return { hotelId: exact.id, suggestedHotelId: null };
    }

    let best: { id: string; score: number } | null = null;
    for (const hotel of hotels) {
      for (const known of hotel.searchNames) {
        const score = nameSimilarity(printedName, known);
        if (score >= SUGGESTION_THRESHOLD && (!best || score > best.score)) {
          best = { id: hotel.id, score };
        }
      }
    }
    return { hotelId: null, suggestedHotelId: best?.id ?? null };
  }
}
