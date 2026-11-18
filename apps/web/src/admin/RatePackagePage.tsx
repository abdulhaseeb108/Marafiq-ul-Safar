/**
 * Review screen (docs/03 section 2.6): the original sheet on the left, the
 * editable pack on the right, problems highlighted on the rows they concern.
 */
import {
  parseMajorToMinor,
  type HotelRateView,
  type HotelView,
  type Paged,
  type PricingMode,
  type RatePackageDetail,
  type SourceDocumentView,
  type ValidationIssue,
} from '@marafiq/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { Alert, Button, Field, Note, Section, errorText } from './ui';

const MODES: PricingMode[] = ['derived_per_person', 'flat_per_room', 'on_request'];
const OCCUPANCIES = ['quint', 'quad', 'triple', 'double'] as const;
const GROUP_SIZES = ['1', '2', '3', '4'] as const;
const LOW_CONFIDENCE = 0.9;

/** Halalas -> "200" or "66.67", for an input. */
function toSar(minor: number | null): string {
  if (minor === null) return '';
  const whole = Math.trunc(minor / 100);
  const part = minor % 100;
  return part === 0 ? String(whole) : `${whole}.${String(part).padStart(2, '0')}`;
}

/** "" -> null (cleared); a bad number -> undefined (ignore the edit). */
function fromSar(text: string): number | null | undefined {
  const cleaned = text.replace(/,/g, '').trim();
  if (cleaned === '') return null;
  try {
    return parseMajorToMinor(cleaned);
  } catch {
    return undefined;
  }
}

/** A SAR amount that saves when the cursor leaves the box. */
function AmountInput({
  value,
  label,
  disabled,
  flagged,
  onCommit,
}: {
  value: number | null;
  label: string;
  disabled: boolean;
  flagged?: boolean;
  onCommit: (minor: number | null) => void;
}) {
  const [text, setText] = useState(toSar(value));
  // Resync the box when the saved figure changes. Done during render, not in an
  // effect: an effect also runs once after mount, and if that run is still pending
  // when someone starts typing it puts the old figure back over their edit.
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(toSar(value));
  }

  function commit() {
    const parsed = fromSar(text);
    if (parsed === undefined) setText(toSar(value));
    else if (parsed !== value) onCommit(parsed);
  }

  return (
    <input
      aria-label={label}
      dir="ltr"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={`min-h-11 w-20 rounded-md border px-2 text-sm disabled:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 ${
        flagged ? 'border-amber-500 bg-amber-50' : 'border-slate-400 bg-white'
      }`}
    />
  );
}

function IssueList({ issues, tone }: { issues: ValidationIssue[]; tone: 'red' | 'amber' }) {
  if (issues.length === 0) return null;
  const look = tone === 'red' ? 'text-red-900' : 'text-amber-900';
  return (
    <ul className={`list-disc space-y-1 ps-5 text-sm ${look}`}>
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`}>{issue.message}</li>
      ))}
    </ul>
  );
}

export function RatePackagePage() {
  const { t } = useTranslation();
  const { packageId = '' } = useParams();
  const navigate = useNavigate();

  const [pack, setPack] = useState<RatePackageDetail | null>(null);
  const [doc, setDoc] = useState<SourceDocumentView | null>(null);
  const [hotels, setHotels] = useState<HotelView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [mapTo, setMapTo] = useState<Record<string, string>>({});
  const [newRowHotel, setNewRowHotel] = useState('');

  useEffect(() => {
    setPack(null);
    api<RatePackageDetail>(`/admin/rate-packages/${packageId}`)
      .then((loaded) => {
        setPack(loaded);
        return api<SourceDocumentView>(`/admin/source-documents/${loaded.sourceDocumentId}`);
      })
      .then(setDoc)
      .catch((err: unknown) => setError(errorText(err, t)));
    api<Paged<HotelView>>('/admin/hotels?limit=200')
      .then((page) => setHotels(page.items))
      .catch(() => undefined);
  }, [packageId, t]);

  /** Every change returns the whole pack again, re-validated by the server. */
  const act = useCallback(
    async (request: () => Promise<RatePackageDetail>): Promise<RatePackageDetail | null> => {
      setBusy(true);
      setError(null);
      try {
        const updated = await request();
        setPack(updated);
        setAcknowledged(false);
        return updated;
      } catch (err) {
        setError(errorText(err, t));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const issuesByRow = useMemo(() => {
    const map = new Map<string, { blocking: ValidationIssue[]; warnings: ValidationIssue[] }>();
    const add = (issue: ValidationIssue, kind: 'blocking' | 'warnings') => {
      if (!issue.path?.startsWith('rate:')) return;
      const key = issue.path.slice(5);
      const entry = map.get(key) ?? { blocking: [], warnings: [] };
      entry[kind].push(issue);
      map.set(key, entry);
    };
    pack?.validation.blocking.forEach((issue) => add(issue, 'blocking'));
    pack?.validation.warnings.forEach((issue) => add(issue, 'warnings'));
    return map;
  }, [pack]);

  if (!pack) return <p>{error ?? t('admin.common.loading')}</p>;

  const base = `/admin/rate-packages/${pack.id}`;
  const editable = pack.status === 'draft' || pack.status === 'needs_review';
  const locked = !editable || busy;
  const general = (list: ValidationIssue[]) => list.filter((i) => !i.path?.startsWith('rate:'));
  const { blocking, warnings } = pack.validation;
  const fileUrl = `/api/v1/admin/source-documents/${pack.sourceDocumentId}/file`;

  const patchPack = (body: object) => act(() => api(base, { method: 'PATCH', body }));
  const patchRate = (rate: HotelRateView, body: object) =>
    act(() => api(`/admin/hotel-rates/${rate.id}`, { method: 'PATCH', body }));

  async function rollback() {
    const restored = await act(() => api(`${base}/rollback`, { method: 'POST' }));
    if (restored) void navigate(`/admin/rate-sheets/${restored.id}`);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link to="/admin/rate-sheets" className="text-emerald-900 underline">
          {t('admin.pack.back')}
        </Link>
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">{pack.packName}</h1>
        <p className="text-sm">
          {pack.supplierName} · {t(`admin.pack.status.${pack.status}`)} · v{pack.version}
          {pack.publishedByName && ` · ${pack.publishedByName}`}
        </p>
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* Left: the original, exactly as the supplier sent it */}
        <div className="xl:sticky xl:top-4 xl:self-start">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{t('admin.pack.original')}</h2>
            <a
              href={fileUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-emerald-900 underline"
            >
              {t('admin.pack.openOriginal')}
            </a>
          </div>
          {doc?.mimeType === 'application/pdf' ? (
            <iframe
              src={fileUrl}
              title={t('admin.pack.original')}
              className="mt-2 h-[80vh] w-full rounded-md border border-slate-300 bg-white"
            />
          ) : doc ? (
            <div className="mt-2 max-h-[80vh] overflow-auto rounded-md border border-slate-300 bg-white">
              <button
                type="button"
                onClick={() => setZoomed(!zoomed)}
                aria-label={t(zoomed ? 'admin.pack.zoomOut' : 'admin.pack.zoomIn')}
                className="block"
              >
                <img
                  src={fileUrl}
                  alt={t('admin.pack.original')}
                  className={zoomed ? 'max-w-none' : 'w-full'}
                />
              </button>
            </div>
          ) : null}
        </div>

        {/* Right: what was read from it */}
        <div className="space-y-6">
          {(blocking.length > 0 || warnings.length > 0) && (
            <div className="space-y-3">
              {blocking.length > 0 && (
                <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3">
                  <p className="font-medium text-red-900">
                    {t('admin.pack.blockingTitle', { count: blocking.length })}
                  </p>
                  <IssueList issues={general(blocking)} tone="red" />
                  {general(blocking).length < blocking.length && (
                    <Note>{t('admin.pack.seeRows')}</Note>
                  )}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="rounded-md border border-amber-400 bg-amber-50 p-3">
                  <p className="font-medium text-amber-900">
                    {t('admin.pack.warningTitle', { count: warnings.length })}
                  </p>
                  <IssueList issues={general(warnings)} tone="amber" />
                  {general(warnings).length < warnings.length && (
                    <Note>{t('admin.pack.seeRows')}</Note>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white p-3">
            {editable && (
              <>
                {warnings.length > 0 && (
                  <label className="flex basis-full items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-5"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                    />
                    {t('admin.pack.acknowledge', { count: warnings.length })}
                  </label>
                )}
                <Button
                  disabled={busy || blocking.length > 0 || (warnings.length > 0 && !acknowledged)}
                  onClick={() =>
                    void act(() =>
                      api(`${base}/publish`, {
                        method: 'POST',
                        body: { acknowledgeWarnings: acknowledged },
                      }),
                    )
                  }
                >
                  {t('admin.pack.publish')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act(() => api(`${base}/validate`, { method: 'POST' }))}
                >
                  {t('admin.pack.recheck')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api(`${base}/reject`, { method: 'POST', body: {} }))
                  }
                >
                  {t('admin.pack.reject')}
                </Button>
              </>
            )}
            {pack.canRollback && (
              <Button variant="secondary" disabled={busy} onClick={() => void rollback()}>
                {t('admin.pack.rollback')}
              </Button>
            )}
            {!editable && <p className="text-sm">{t('admin.pack.readOnly')}</p>}
          </div>

          <Section title={t('admin.pack.headerTitle')}>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['packName', 'text'],
                  ['seasonLabel', 'text'],
                  ['nightFrom', 'date'],
                  ['nightTo', 'date'],
                  ['issueDate', 'date'],
                  ['effectiveFrom', 'date'],
                ] as const
              ).map(([key, type]) => (
                <Field
                  key={`${key}-${pack[key] ?? ''}`}
                  id={`pack-${key}`}
                  type={type}
                  dir={type === 'date' ? 'ltr' : undefined}
                  label={t(`admin.pack.fields.${key}`)}
                  disabled={locked}
                  defaultValue={pack[key] ?? ''}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value === (pack[key] ?? '')) return;
                    if (key === 'packName' && value === '') return;
                    void patchPack({ [key]: value === '' ? null : value });
                  }}
                />
              ))}
              {(pack.replaceable.length > 0 || pack.supersedesId) && (
                <div className="sm:col-span-2">
                  <label htmlFor="pack-replaces" className="block text-sm font-medium">
                    {t('admin.pack.replaces')}
                  </label>
                  <select
                    id="pack-replaces"
                    disabled={locked}
                    value={pack.supersedesId ?? ''}
                    onChange={(e) => void patchPack({ supersedesId: e.target.value || null })}
                    className="mt-1 block min-h-11 w-full rounded-md border border-slate-400 bg-white px-3 text-base disabled:bg-slate-100"
                  >
                    <option value="">{t('admin.pack.replacesNone')}</option>
                    {pack.replaceable.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.packName} ({other.nightFrom} → {other.nightTo})
                      </option>
                    ))}
                  </select>
                  <Note>{t('admin.pack.replacesHint')}</Note>
                </div>
              )}
            </div>
          </Section>

          <Section title={t('admin.pack.visaTitle')}>
            <div className="mt-3 flex flex-wrap gap-4">
              <label className="text-sm">
                <span className="block font-medium">{t('admin.pack.visa.direct')}</span>
                <AmountInput
                  label={t('admin.pack.visa.direct')}
                  value={pack.visa.directPerPersonMinor}
                  disabled={locked}
                  onCommit={(minor) => void patchPack({ visa: { directPerPersonMinor: minor } })}
                />
              </label>
              {GROUP_SIZES.map((size) => (
                <label key={size} className="text-sm">
                  <span className="block font-medium">
                    {t('admin.pack.visa.indirect', { count: Number(size) })}
                  </span>
                  <AmountInput
                    label={t('admin.pack.visa.indirect', { count: Number(size) })}
                    value={pack.visa.indirectByGroupSizeMinor[size]}
                    disabled={locked}
                    onCommit={(minor) =>
                      void patchPack({ visa: { indirectByGroupSizeMinor: { [size]: minor } } })
                    }
                  />
                </label>
              ))}
              <label className="text-sm">
                <span className="block font-medium">{t('admin.pack.visa.infant')}</span>
                <AmountInput
                  label={t('admin.pack.visa.infant')}
                  value={pack.visa.infantMinor}
                  disabled={locked}
                  onCommit={(minor) => void patchPack({ visa: { infantMinor: minor } })}
                />
              </label>
            </div>
            {pack.visa.appliesNote && <Note>{pack.visa.appliesNote}</Note>}
          </Section>

          <Section title={t('admin.pack.ratesTitle', { count: pack.rates.length })}>
            <Note>{t('admin.pack.ratesHint')}</Note>
            <ul className="mt-3 space-y-3">
              {pack.rates.map((rate) => {
                const issues = issuesByRow.get(rate.id);
                const unsure = rate.confidence < LOW_CONFIDENCE && !rate.edited;
                const cityHotels = hotels.filter((hotel) => hotel.city === rate.printed.city);
                const chosen = mapTo[rate.id] ?? rate.suggestedHotelId ?? '';
                const name = rate.hotelName ?? rate.printed.name;
                const border = issues?.blocking.length
                  ? 'border-red-400'
                  : issues?.warnings.length || unsure
                    ? 'border-amber-400'
                    : 'border-slate-200';
                return (
                  <li key={rate.id} className={`rounded-lg border bg-white p-3 ${border}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{name}</p>
                        <p className="text-sm text-slate-700">
                          {t(`admin.hotels.cities.${rate.printed.city}`)}
                          {rate.hotelName && rate.hotelName !== rate.printed.name && (
                            <span dir="ltr">
                              {' '}
                              · {t('admin.pack.printedAs', { name: rate.printed.name })}
                            </span>
                          )}
                          {rate.edited && (
                            <span className="ms-2 rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-900">
                              {t('admin.pack.edited')}
                            </span>
                          )}
                          {unsure && (
                            <span className="ms-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                              {t('admin.pack.unsure')}
                            </span>
                          )}
                        </p>
                      </div>
                      {editable && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          aria-label={t('admin.pack.removeRowFor', { name })}
                          onClick={() =>
                            void act(() =>
                              api(`/admin/hotel-rates/${rate.id}`, { method: 'DELETE' }),
                            )
                          }
                        >
                          {t('admin.pack.removeRow')}
                        </Button>
                      )}
                    </div>

                    {!rate.hotelId && editable && (
                      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-red-50 p-2">
                        <div>
                          <label htmlFor={`map-${rate.id}`} className="block text-sm font-medium">
                            {t('admin.pack.unknownHotel')}
                          </label>
                          <select
                            id={`map-${rate.id}`}
                            value={chosen}
                            onChange={(e) => setMapTo({ ...mapTo, [rate.id]: e.target.value })}
                            className="mt-1 min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm"
                          >
                            <option value="">{t('admin.pack.chooseHotel')}</option>
                            {cityHotels.map((hotel) => (
                              <option key={hotel.id} value={hotel.id}>
                                {hotel.canonicalName}
                                {hotel.id === rate.suggestedHotelId
                                  ? ` (${t('admin.pack.suggested')})`
                                  : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                        <Button
                          disabled={busy || !chosen}
                          onClick={() =>
                            void act(() =>
                              api(`/admin/hotel-rates/${rate.id}/confirm-hotel`, {
                                method: 'POST',
                                body: { action: 'map', hotelId: chosen },
                              }),
                            )
                          }
                        >
                          {t('admin.pack.sameHotel')}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              api(`/admin/hotel-rates/${rate.id}/confirm-hotel`, {
                                method: 'POST',
                                body: { action: 'create' },
                              }),
                            )
                          }
                        >
                          {t('admin.pack.newHotel')}
                        </Button>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <label className="text-xs">
                        <span className="block">{t('admin.pack.mode')}</span>
                        <select
                          aria-label={t('admin.pack.modeFor', { name })}
                          disabled={locked}
                          value={rate.pricingMode}
                          onChange={(e) => void patchRate(rate, { pricingMode: e.target.value })}
                          className="min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm disabled:bg-slate-100"
                        >
                          {MODES.map((mode) => (
                            <option key={mode} value={mode}>
                              {t(`admin.pack.modes.${mode}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {rate.pricingMode !== 'on_request' && (
                        <>
                          <label className="text-xs">
                            <span className="block">{t('admin.pack.room')}</span>
                            <AmountInput
                              label={t('admin.pack.amountFor', {
                                column: t('admin.pack.room'),
                                name,
                              })}
                              value={rate.roomPriceMinor}
                              disabled={locked}
                              flagged={unsure}
                              onCommit={(minor) => void patchRate(rate, { roomPriceMinor: minor })}
                            />
                          </label>
                          {OCCUPANCIES.map((key) => (
                            <label key={key} className="text-xs">
                              <span className="block">{t(`admin.pack.occupancy.${key}`)}</span>
                              <AmountInput
                                label={t('admin.pack.amountFor', {
                                  column: t(`admin.pack.occupancy.${key}`),
                                  name,
                                })}
                                value={rate.perPersonMinor[key]}
                                disabled={locked}
                                flagged={unsure}
                                onCommit={(minor) =>
                                  void patchRate(rate, { perPersonMinor: { [key]: minor } })
                                }
                              />
                            </label>
                          ))}
                        </>
                      )}
                    </div>
                    {rate.flatNote && <Note>{rate.flatNote}</Note>}
                    {issues && (
                      <div className="mt-2 space-y-1">
                        <IssueList issues={issues.blocking} tone="red" />
                        <IssueList issues={issues.warnings} tone="amber" />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {editable && (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="new-row-hotel" className="block text-sm font-medium">
                    {t('admin.pack.addRow')}
                  </label>
                  <select
                    id="new-row-hotel"
                    value={newRowHotel}
                    onChange={(e) => setNewRowHotel(e.target.value)}
                    className="mt-1 min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm"
                  >
                    <option value="">{t('admin.pack.chooseHotel')}</option>
                    {hotels
                      .filter((hotel) => !pack.rates.some((rate) => rate.hotelId === hotel.id))
                      .map((hotel) => (
                        <option key={hotel.id} value={hotel.id}>
                          {hotel.canonicalName} ({t(`admin.hotels.cities.${hotel.city}`)})
                        </option>
                      ))}
                  </select>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy || !newRowHotel}
                  onClick={() =>
                    void act(() =>
                      api(`${base}/hotel-rates`, {
                        method: 'POST',
                        body: { hotelId: newRowHotel, pricingMode: 'on_request' },
                      }),
                    ).then((ok) => ok && setNewRowHotel(''))
                  }
                >
                  {t('admin.pack.addRowButton')}
                </Button>
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
