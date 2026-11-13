/**
 * Turns the engine's {code, message, params} notes into the reader's language.
 * Unknown codes fall back to the English message from the server.
 */
import type { Note } from '@marafiq/shared';
import type { TFunction } from 'i18next';
import { formatDay } from '../format';

export function noteText(t: TFunction, language: string, note: Note): string {
  const params: Record<string, string | number> = { ...(note.params ?? {}) };
  for (const key of ['from', 'to'] as const) {
    const value = params[key];
    if (typeof value === 'string') params[key] = formatDay(value, language);
  }
  if (typeof params.occupancy === 'string')
    params.occupancy = t(`calc.occupancy.${params.occupancy}`);
  if (typeof params.city === 'string') params.city = t(`calc.city.${params.city}`);
  if (typeof params.extra === 'string') params.extra = t(`calc.extras.${params.extra}`);
  if (params.from !== undefined && params.from === params.to) params.dates = params.from;
  else if (params.from !== undefined)
    params.dates = t('calc.dateRange', { from: params.from, to: params.to });
  return t(`calc.notes.${note.code}`, { ...params, defaultValue: note.message });
}
