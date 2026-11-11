import {
  formatMinor,
  parseMajorToMinor,
  type Destination,
  type FlightEstimateView,
} from '@marafiq/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useResource } from './useResource';
import { Alert, Button, Field, Note, Section, Select, Table } from './ui';

const DESTINATIONS: Destination[] = ['JED', 'MED'];
const EMPTY = {
  originCity: '',
  destination: 'JED' as Destination,
  low: '',
  high: '',
  validTo: '',
  note: '',
  source: '',
};

/** Staff type whole rupees; the API stores paisa (CLAUDE.md hard rule 1). */
function toMinor(rupees: string): number | null {
  try {
    return parseMajorToMinor(rupees.replace(/,/g, '').trim());
  } catch {
    return null;
  }
}

export function FlightEstimatesPage() {
  const { t } = useTranslation();
  const { items, error, formErrors, busy, run, setError } =
    useResource<FlightEstimateView>('/admin/flight-estimates');
  const [form, setForm] = useState(EMPTY);

  async function add(event: FormEvent) {
    event.preventDefault();
    const lowMinor = toMinor(form.low);
    const highMinor = toMinor(form.high);
    if (lowMinor === null || highMinor === null) {
      setError(t('admin.flights.amountRule'));
      return;
    }
    const ok = await run(() =>
      api('/admin/flight-estimates', {
        method: 'POST',
        body: {
          originCity: form.originCity,
          destination: form.destination,
          lowMinor,
          highMinor,
          validTo: form.validTo,
          note: form.note,
          source: form.source,
        },
      }),
    );
    if (ok) setForm(EMPTY);
  }

  const extend = (id: string, validTo: string) =>
    run(() => api(`/admin/flight-estimates/${id}`, { method: 'PATCH', body: { validTo } }));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.flights.title')}</h1>
      <Note>{t('admin.flights.intro')}</Note>
      {error && <Alert>{error}</Alert>}

      <Section title={t('admin.flights.addTitle')}>
        <form onSubmit={add} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
          <Field
            id="f-city"
            label={t('admin.flights.originCity')}
            required
            value={form.originCity}
            error={formErrors.originCity}
            onChange={(e) => setForm({ ...form, originCity: e.target.value })}
          />
          <Select
            id="f-dest"
            label={t('admin.flights.destination')}
            value={form.destination}
            onChange={(e) => setForm({ ...form, destination: e.target.value as Destination })}
          >
            {DESTINATIONS.map((destination) => (
              <option key={destination} value={destination}>
                {t(`admin.flights.destinations.${destination}`)}
              </option>
            ))}
          </Select>
          <Field
            id="f-low"
            dir="ltr"
            inputMode="numeric"
            label={t('admin.flights.low')}
            required
            value={form.low}
            onChange={(e) => setForm({ ...form, low: e.target.value })}
          />
          <Field
            id="f-high"
            dir="ltr"
            inputMode="numeric"
            label={t('admin.flights.high')}
            required
            value={form.high}
            error={formErrors.highMinor && t('admin.flights.rangeRule')}
            onChange={(e) => setForm({ ...form, high: e.target.value })}
          />
          <Field
            id="f-valid"
            type="date"
            dir="ltr"
            label={t('admin.flights.validTo')}
            required
            value={form.validTo}
            error={formErrors.validTo}
            onChange={(e) => setForm({ ...form, validTo: e.target.value })}
          />
          <Field
            id="f-source"
            label={t('admin.flights.source')}
            required
            value={form.source}
            error={formErrors.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
          />
          <Field
            id="f-note"
            label={t('admin.flights.note')}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('admin.flights.add')}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t('admin.flights.listTitle')}>
        {items === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : (
          <Table
            headers={[
              t('admin.flights.originCity'),
              t('admin.flights.destination'),
              t('admin.flights.range'),
              t('admin.flights.validTo'),
              t('admin.flights.source'),
              t('admin.common.actions'),
            ]}
          >
            {items.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-slate-200 ${row.expired ? 'opacity-60' : ''}`}
              >
                <td className="px-3 py-2">{row.originCity}</td>
                <td className="px-3 py-2">{t(`admin.flights.destinations.${row.destination}`)}</td>
                <td dir="ltr" className="px-3 py-2 text-start">
                  {formatMinor(row.lowMinor)} – {formatMinor(row.highMinor)}
                </td>
                <td className="px-3 py-2">
                  <span dir="ltr">{row.validTo}</span>
                  {row.expired && (
                    <span className="ms-2 rounded bg-amber-100 px-2 py-0.5 text-xs">
                      {t('admin.flights.expired')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {row.source}
                  {row.note && <span className="block text-slate-700">{row.note}</span>}
                </td>
                <td className="px-3 py-2">
                  <label htmlFor={`valid-${row.id}`} className="sr-only">
                    {t('admin.flights.changeValidTo', { city: row.originCity })}
                  </label>
                  <input
                    id={`valid-${row.id}`}
                    type="date"
                    dir="ltr"
                    defaultValue={row.validTo}
                    disabled={busy}
                    onChange={(e) => e.target.value && void extend(row.id, e.target.value)}
                    className="min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm"
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
