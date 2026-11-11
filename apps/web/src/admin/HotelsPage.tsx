import type { City, HotelView, Transport } from '@marafiq/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useAuth } from './AuthContext';
import { useResource } from './useResource';
import { Alert, Button, Field, Note, Section, Select, Textarea } from './ui';

const CITIES: City[] = ['makkah', 'madinah'];
const TRANSPORTS: Transport[] = ['walking', 'shuttle', 'unknown'];
const EMPTY = {
  city: 'makkah' as City,
  canonicalName: '',
  aliases: '',
  distanceMeters: '',
  distanceNote: '',
  transport: 'unknown' as Transport,
  starRating: '',
};

/** Aliases are edited as one line per name, which matches how sheets print them. */
const parseAliases = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function HotelsPage() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const { items, error, formErrors, busy, run } = useResource<HotelView>(
    '/admin/hotels?limit=200&includeInactive=true',
  );
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<{ id: string; aliases: string } | null>(null);
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({});

  const canEdit = state.status === 'authenticated' && ['admin', 'ops'].includes(state.user.role);

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() =>
      api('/admin/hotels', {
        method: 'POST',
        body: {
          city: form.city,
          canonicalName: form.canonicalName,
          aliases: parseAliases(form.aliases),
          distanceMeters: form.distanceMeters === '' ? null : Number(form.distanceMeters),
          distanceNote: form.distanceNote,
          transport: form.transport,
          starRating: form.starRating === '' ? null : Number(form.starRating),
        },
      }),
    );
    if (ok) setForm(EMPTY);
  }

  async function saveAliases() {
    if (!editing) return;
    const ok = await run(() =>
      api(`/admin/hotels/${editing.id}`, {
        method: 'PATCH',
        body: { aliases: parseAliases(editing.aliases) },
      }),
    );
    if (ok) setEditing(null);
  }

  const merge = (duplicateId: string) =>
    run(() =>
      api(`/admin/hotels/${duplicateId}/merge`, {
        method: 'POST',
        body: { targetId: mergeInto[duplicateId] },
      }),
    );

  const live = (items ?? []).filter((hotel) => !hotel.mergedIntoId);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.hotels.title')}</h1>
      {error && <Alert>{error}</Alert>}

      {canEdit && (
        <Section title={t('admin.hotels.addTitle')}>
          <form onSubmit={add} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
            <Select
              id="h-city"
              label={t('admin.hotels.city')}
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value as City })}
            >
              {CITIES.map((city) => (
                <option key={city} value={city}>
                  {t(`admin.hotels.cities.${city}`)}
                </option>
              ))}
            </Select>
            <Field
              id="h-name"
              label={t('admin.hotels.name')}
              required
              value={form.canonicalName}
              error={formErrors.canonicalName}
              onChange={(e) => setForm({ ...form, canonicalName: e.target.value })}
            />
            <Textarea
              id="h-aliases"
              label={t('admin.hotels.aliases')}
              rows={3}
              value={form.aliases}
              onChange={(e) => setForm({ ...form, aliases: e.target.value })}
            />
            <div className="grid gap-4">
              <Field
                id="h-distance"
                type="number"
                min={0}
                label={t('admin.hotels.distanceMeters')}
                value={form.distanceMeters}
                error={formErrors.distanceMeters}
                onChange={(e) => setForm({ ...form, distanceMeters: e.target.value })}
              />
              <Field
                id="h-stars"
                type="number"
                min={1}
                max={5}
                label={t('admin.hotels.starRating')}
                value={form.starRating}
                error={formErrors.starRating}
                onChange={(e) => setForm({ ...form, starRating: e.target.value })}
              />
            </div>
            <Field
              id="h-note"
              label={t('admin.hotels.distanceNote')}
              value={form.distanceNote}
              onChange={(e) => setForm({ ...form, distanceNote: e.target.value })}
            />
            <Select
              id="h-transport"
              label={t('admin.hotels.transport')}
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}
            >
              {TRANSPORTS.map((transport) => (
                <option key={transport} value={transport}>
                  {t(`admin.hotels.transports.${transport}`)}
                </option>
              ))}
            </Select>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {t('admin.hotels.add')}
              </Button>
              <Note>{t('admin.hotels.starHint')}</Note>
            </div>
          </form>
        </Section>
      )}

      <Section title={t('admin.hotels.listTitle')}>
        {items === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {items.map((hotel) => (
              <li
                key={hotel.id}
                className={`rounded-lg border border-slate-200 bg-white p-4 ${hotel.mergedIntoId ? 'opacity-60' : ''}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{hotel.canonicalName}</p>
                    <p className="text-sm text-slate-700">
                      {t(`admin.hotels.cities.${hotel.city}`)} ·{' '}
                      {t(`admin.hotels.transports.${hotel.transport}`)}
                      {hotel.distanceMeters !== null && ` · ${hotel.distanceMeters} m`}
                      {hotel.starRating !== null &&
                        ` · ${t('admin.hotels.stars', { count: hotel.starRating })}`}
                    </p>
                    {hotel.distanceNote && <p className="text-sm">{hotel.distanceNote}</p>}
                    {hotel.aliases.length > 0 && (
                      <p className="mt-1 text-sm">
                        {t('admin.hotels.alsoKnownAs')}: {hotel.aliases.join(' · ')}
                      </p>
                    )}
                    {hotel.mergedIntoId && <Note>{t('admin.hotels.mergedAway')}</Note>}
                  </div>

                  {canEdit && !hotel.mergedIntoId && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          setEditing({ id: hotel.id, aliases: hotel.aliases.join('\n') })
                        }
                      >
                        {t('admin.hotels.editAliases')}
                      </Button>
                      <label htmlFor={`merge-${hotel.id}`} className="sr-only">
                        {t('admin.hotels.mergeInto')}
                      </label>
                      <select
                        id={`merge-${hotel.id}`}
                        value={mergeInto[hotel.id] ?? ''}
                        onChange={(e) => setMergeInto({ ...mergeInto, [hotel.id]: e.target.value })}
                        className="min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm"
                      >
                        <option value="">{t('admin.hotels.mergeInto')}</option>
                        {live
                          .filter((other) => other.id !== hotel.id && other.city === hotel.city)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.canonicalName}
                            </option>
                          ))}
                      </select>
                      <Button
                        variant="secondary"
                        disabled={busy || !mergeInto[hotel.id]}
                        onClick={() => void merge(hotel.id)}
                      >
                        {t('admin.hotels.merge')}
                      </Button>
                    </div>
                  )}
                </div>

                {editing?.id === hotel.id && (
                  <div className="mt-4 border-t border-slate-200 pt-4">
                    <Textarea
                      id={`aliases-${hotel.id}`}
                      label={t('admin.hotels.aliases')}
                      rows={4}
                      value={editing.aliases}
                      onChange={(e) => setEditing({ ...editing, aliases: e.target.value })}
                    />
                    <div className="mt-3 flex gap-2">
                      <Button disabled={busy} onClick={() => void saveAliases()}>
                        {t('admin.common.save')}
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(null)}>
                        {t('admin.common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
