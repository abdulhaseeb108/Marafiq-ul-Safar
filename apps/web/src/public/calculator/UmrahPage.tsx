/**
 * The Umrah calculator (docs/01 section 4): the form, then the estimate below.
 * Prices come only from POST /public/calculate; nothing is priced here.
 */
import {
  EXTRAS,
  ROOM_OCCUPANCIES,
  type CalculationResult,
  type PublicHotel,
  type RoomOccupancy,
} from '@marafiq/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError, api } from '../../lib/api';
import { useCurrency } from '../CurrencyContext';
import { addDays, formatDay, ltr, money, todayInPakistan } from '../format';
import { Card, PageTitle, buttonPrimary, buttonSecondary, focusRing } from '../ui';
import { usePublicConfig, usePublicHotels } from '../usePublic';
import {
  OTHER_CITY,
  bedsIn,
  initialForm,
  peopleInRooms,
  toInput,
  validate,
  type FormErrors,
  type FormState,
} from './form';
import { ResultView } from './ResultView';

const fieldId = (path: string) => `f-${path.replace(/\./g, '-')}`;
const input = `mt-1 block min-h-11 w-full rounded-md border border-slate-500 bg-white px-3 ${focusRing}`;

/** Server messages are English; ours are translation keys. */
const SERVER = 'server:';

function ErrorText({ id, error }: { id: string; error?: string }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p id={`${id}-error`} className="mt-1 text-sm font-semibold text-red-800">
      {error.startsWith(SERVER) ? error.slice(SERVER.length) : t(error)}
    </p>
  );
}

function NumberField(props: {
  path: string;
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  error?: string;
  onChange: (value: number) => void;
}) {
  const id = fieldId(props.path);
  const described = [props.hint ? `${id}-hint` : '', props.error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <label htmlFor={id} className="font-medium">
        {props.label}
      </label>
      {props.hint && (
        <p id={`${id}-hint`} className="text-sm text-slate-700">
          {props.hint}
        </p>
      )}
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        step={1}
        value={Number.isNaN(props.value) ? '' : props.value}
        onChange={(event) =>
          props.onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))
        }
        aria-invalid={props.error ? true : undefined}
        aria-describedby={described || undefined}
        className={input}
        dir="ltr"
      />
      <ErrorText id={id} error={props.error} />
    </div>
  );
}

function Choice<T extends string>(props: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="font-medium">{props.legend}</legend>
      <div className="mt-1 grid gap-2 sm:grid-cols-2">
        {props.options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-slate-300 bg-white p-2 has-[:checked]:border-emerald-800 has-[:checked]:bg-emerald-50"
          >
            <input
              type="radio"
              name={props.name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
              className={`mt-1 size-4 ${focusRing}`}
            />
            <span>
              {option.label}
              {option.hint && <span className="block text-sm text-slate-700">{option.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold">
        <span className="me-2 text-emerald-800">{number}.</span>
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

function HotelPicker(props: {
  city: 'makkah' | 'madinah';
  value: string;
  hotels: PublicHotel[] | null;
  onChange: (value: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { primary } = useCurrency();
  const id = fieldId(`hotels.${props.city}`);
  const list = (props.hotels ?? []).filter((h) => h.city === props.city);
  const chosen = list.find((h) => h.id === props.value);

  const price = (hotel: PublicHotel) => {
    if (hotel.onRequestOnly) return t('calc.requestQuote');
    const from = hotel.fromPerPerson ?? hotel.fromPerRoom;
    if (!from) return t('calc.requestQuote');
    const amount =
      primary === 'SAR' && from.minorSAR !== null
        ? money('SAR', from.minorSAR)
        : from.minorPKR !== null
          ? money('PKR', from.minorPKR)
          : from.minorSAR !== null
            ? money('SAR', from.minorSAR)
            : '';
    return t(hotel.fromPerPerson ? 'calc.hotelFromPerson' : 'calc.hotelFromRoom', {
      price: ltr(amount, i18n.language),
    });
  };
  // Supplier text (names, distance notes) is English; in Urdu each run is isolated
  // so an option reads name -> distance -> price from the right, and the start of
  // the hotel name, not the price, stays visible in the closed RTL select.
  const distance = (hotel: PublicHotel) =>
    (hotel.distanceNote && ltr(hotel.distanceNote, i18n.language)) ||
    (hotel.distanceMeters !== null
      ? t('hotels.distance', {
          meters: ltr(hotel.distanceMeters.toLocaleString('en-US'), i18n.language),
        })
      : t('hotels.distanceUnknown'));

  return (
    <div>
      <label htmlFor={id} className="font-medium">
        {t('calc.hotelIn', { city: t(`calc.city.${props.city}`) })}
      </label>
      <select
        id={id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={input}
      >
        <option value="cheapest">{t('calc.cheapest')}</option>
        <option value="nearest">{t('calc.nearest')}</option>
        {list.map((hotel) => (
          <option key={hotel.id} value={hotel.id}>
            {`${ltr(hotel.name, i18n.language)} — ${distance(hotel)} — ${price(hotel)}`}
          </option>
        ))}
      </select>
      {chosen ? (
        <p className="mt-1 text-sm text-slate-700">
          {/* A closed select cannot wrap, so the full name is repeated here. */}
          <bdi lang="en" className="font-medium break-words">
            {chosen.name}
          </bdi>
          {' · '}
          {distance(chosen)} · {t(`hotels.transport.${chosen.transport}`)} · {price(chosen)}
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-700">{t('calc.pickHint')}</p>
      )}
      {props.hotels !== null && list.length === 0 && (
        <p className="mt-1 text-sm text-slate-700">{t('calc.noHotels')}</p>
      )}
    </div>
  );
}

export function UmrahPage() {
  const { t, i18n } = useTranslation();
  const config = usePublicConfig();
  const hotels = usePublicHotels();
  const [form, setForm] = useState<FormState>(initialForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CalculationResult | null>(null);
  /** Bumped each time a submit finds problems, to move focus to the list. */
  const [errorTurn, setErrorTurn] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const nextKey = useRef(2);
  const roomsHint = useId();

  const cities = config.status === 'ready' ? config.data.departureCities : [];
  const today = todayInPakistan();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (errorTurn > 0) summaryRef.current?.focus();
  }, [errorTurn]);

  // Show the estimate and move focus to it, for keyboard and screen-reader users.
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  function setRoom(index: number, change: Partial<{ occupancy: RoomOccupancy; persons: number }>) {
    setForm((f) => ({
      ...f,
      rooms: f.rooms.map((room, i) => {
        if (i !== index) return room;
        const next = { ...room, ...change };
        // Fewer beds than people after changing the type: fit the room.
        if (change.occupancy && next.persons > bedsIn(next.occupancy))
          next.persons = bedsIn(next.occupancy);
        return next;
      }),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setResult(null);
      setErrorTurn((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      setResult(
        await api<CalculationResult>('/public/calculate', {
          method: 'POST',
          body: toInput(form),
          retryOn401: false,
        }),
      );
    } catch (error) {
      setResult(null);
      if (error instanceof ApiRequestError && error.code === 'validation_error' && error.fields) {
        setErrors(
          Object.fromEntries(Object.entries(error.fields).map(([k, v]) => [k, `${SERVER}${v}`])),
        );
        setErrorTurn((n) => n + 1);
      } else if (error instanceof ApiRequestError && error.code === 'prices_unavailable') {
        setFailure('calc.unavailable');
      } else {
        setFailure('site.loadError');
      }
    } finally {
      setBusy(false);
    }
  }

  const errorList = Object.entries(errors);
  const placed = peopleInRooms(form);
  const needed = (form.adults || 0) + (form.children || 0);

  return (
    <div className="space-y-6">
      <PageTitle title={t('calc.title')} intro={t('calc.intro')} />

      <form
        noValidate
        onSubmit={(e) => void submit(e)}
        className="space-y-4"
        aria-describedby="calc-notice"
      >
        <p id="calc-notice" className="text-sm text-slate-700">
          {t('calc.notice')}
        </p>

        {errorList.length > 0 && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border-2 border-red-700 bg-red-50 p-4"
          >
            <p className="font-semibold">{t('calc.errors.summary')}</p>
            <ul className="mt-2 list-disc ps-5">
              {errorList.map(([path, message]) => (
                <li key={path}>
                  <a href={`#${fieldId(path)}`} className={`underline ${focusRing}`}>
                    {message.startsWith(SERVER) ? message.slice(SERVER.length) : t(message)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Step number={1} title={t('calc.stepTrip')}>
          <div>
            <label htmlFor={fieldId('departureCity')} className="font-medium">
              {t('calc.departureCity')}
            </label>
            <select
              id={fieldId('departureCity')}
              value={form.departureCity}
              onChange={(e) => set('departureCity', e.target.value)}
              className={input}
            >
              <option value="">{t('calc.chooseCity')}</option>
              {cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
              <option value={OTHER_CITY}>{t('calc.otherCity')}</option>
            </select>
            {form.departureCity === OTHER_CITY && (
              <div className="mt-2">
                <label htmlFor={fieldId('otherCity')} className="text-sm font-medium">
                  {t('calc.otherCityName')}
                </label>
                <input
                  id={fieldId('otherCity')}
                  value={form.otherCity}
                  maxLength={80}
                  onChange={(e) => set('otherCity', e.target.value)}
                  className={input}
                  autoComplete="address-level2"
                />
                <p className="mt-1 text-sm text-slate-700">{t('calc.otherCityHint')}</p>
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={fieldId('arrivalDate')} className="font-medium">
                {t('calc.arrivalDate')}
              </label>
              <input
                id={fieldId('arrivalDate')}
                type="date"
                min={today}
                value={form.arrivalDate}
                onChange={(e) => set('arrivalDate', e.target.value)}
                aria-invalid={errors.arrivalDate ? true : undefined}
                aria-describedby={
                  errors.arrivalDate ? `${fieldId('arrivalDate')}-error` : undefined
                }
                className={input}
                dir="ltr"
              />
              <ErrorText id={fieldId('arrivalDate')} error={errors.arrivalDate} />
            </div>
            <NumberField
              path="flexibilityDays"
              label={t('calc.flexibility')}
              hint={t('calc.flexibilityHint')}
              value={form.flexibilityDays}
              min={0}
              max={14}
              onChange={(v) => set('flexibilityDays', v)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              path="nightsMakkah"
              label={t('calc.nightsMakkah')}
              value={form.nightsMakkah}
              min={0}
              max={30}
              error={errors.nightsMakkah}
              onChange={(v) => set('nightsMakkah', v)}
            />
            <NumberField
              path="nightsMadinah"
              label={t('calc.nightsMadinah')}
              value={form.nightsMadinah}
              min={0}
              max={30}
              error={errors.nightsMadinah}
              onChange={(v) => set('nightsMadinah', v)}
            />
          </div>
          <Choice
            name="order"
            legend={t('calc.order')}
            value={form.order}
            options={[
              { value: 'makkah_first', label: t('calc.makkahFirst') },
              { value: 'madinah_first', label: t('calc.madinahFirst') },
            ]}
            onChange={(v) => set('order', v)}
          />
          {form.arrivalDate && form.nightsMakkah + form.nightsMadinah > 0 && (
            <p className="text-sm text-slate-700">
              {t('calc.leaveOn', {
                date: formatDay(
                  addDays(form.arrivalDate, form.nightsMakkah + form.nightsMadinah),
                  i18n.language,
                ),
              })}
            </p>
          )}
        </Step>

        <Step number={2} title={t('calc.stepTravelers')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              path="travelers.adults"
              label={t('calc.adults')}
              value={form.adults}
              min={1}
              max={49}
              error={errors['travelers.adults']}
              onChange={(v) => set('adults', v)}
            />
            <NumberField
              path="travelers.children"
              label={t('calc.children')}
              hint={t('calc.childrenHint')}
              value={form.children}
              min={0}
              max={48}
              error={errors['travelers.children']}
              onChange={(v) => set('children', v)}
            />
            <NumberField
              path="travelers.infants"
              label={t('calc.infants')}
              hint={t('calc.infantsHint')}
              value={form.infants}
              min={0}
              max={48}
              error={errors['travelers.infants']}
              onChange={(v) => set('infants', v)}
            />
          </div>
          <ErrorText id={fieldId('travelers')} error={errors.travelers} />

          <fieldset aria-describedby={roomsHint}>
            <legend id={fieldId('rooms')} tabIndex={-1} className="font-medium">
              {t('calc.rooms')}
            </legend>
            <p
              id={roomsHint}
              aria-live="polite"
              className={`text-sm ${placed === needed ? 'text-slate-700' : 'font-semibold text-red-800'}`}
            >
              {t('calc.placed', { placed, needed })}
            </p>
            <ErrorText id={fieldId('rooms')} error={errors.rooms} />
            <ol className="mt-2 space-y-3">
              {form.rooms.map((room, index) => {
                const label = t('calc.roomN', { n: index + 1 });
                return (
                  <li key={room.key} className="rounded-md border border-slate-300 p-3">
                    <p className="mb-2 font-medium">{label}</p>
                    <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                      <div>
                        <label htmlFor={fieldId(`rooms.${index}.occupancy`)} className="text-sm">
                          {t('calc.roomType')}
                        </label>
                        <select
                          id={fieldId(`rooms.${index}.occupancy`)}
                          value={room.occupancy}
                          onChange={(e) =>
                            setRoom(index, { occupancy: e.target.value as RoomOccupancy })
                          }
                          className={input}
                        >
                          {ROOM_OCCUPANCIES.map((o) => (
                            <option key={o} value={o}>
                              {t(`calc.occupancyOption.${o}`)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <NumberField
                        path={`rooms.${index}.persons`}
                        label={t('calc.inRoom')}
                        value={room.persons}
                        min={1}
                        max={bedsIn(room.occupancy)}
                        error={errors[`rooms.${index}.persons`]}
                        onChange={(v) => setRoom(index, { persons: v })}
                      />
                      {form.rooms.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            set(
                              'rooms',
                              form.rooms.filter((_, i) => i !== index),
                            )
                          }
                          className={buttonSecondary}
                          aria-label={t('calc.removeRoomN', { n: index + 1 })}
                        >
                          {t('calc.removeRoom')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {form.rooms.length < 20 && (
              <button
                type="button"
                className={`mt-3 ${buttonSecondary}`}
                onClick={() =>
                  set('rooms', [
                    ...form.rooms,
                    { key: nextKey.current++, occupancy: 'double', persons: 2 },
                  ])
                }
              >
                {t('calc.addRoom')}
              </button>
            )}
          </fieldset>
        </Step>

        <Step number={3} title={t('calc.stepHotels')}>
          {hotels.status === 'error' && <p role="alert">{t('site.loadError')}</p>}
          {form.nightsMakkah > 0 && (
            <HotelPicker
              city="makkah"
              value={form.makkahHotel}
              hotels={hotels.status === 'ready' ? hotels.data.items : null}
              onChange={(v) => set('makkahHotel', v)}
            />
          )}
          {form.nightsMadinah > 0 && (
            <HotelPicker
              city="madinah"
              value={form.madinahHotel}
              hotels={hotels.status === 'ready' ? hotels.data.items : null}
              onChange={(v) => set('madinahHotel', v)}
            />
          )}
        </Step>

        <Step number={4} title={t('calc.stepVisaFlight')}>
          <Choice
            name="visa"
            legend={t('calc.visa')}
            value={form.visa}
            options={[
              { value: 'direct', label: t('calc.visaDirect') },
              { value: 'indirect', label: t('calc.visaIndirect') },
            ]}
            onChange={(v) => set('visa', v)}
          />
          <Choice
            name="flight"
            legend={t('calc.flight')}
            value={form.flight}
            options={[
              {
                value: 'estimate',
                label: t('calc.flightEstimate'),
                hint: t('calc.flightEstimateHint'),
              },
              { value: 'self', label: t('calc.flightSelf') },
            ]}
            onChange={(v) => set('flight', v)}
          />
          <fieldset>
            <legend className="font-medium">{t('calc.extrasTitle')}</legend>
            <p className="text-sm text-slate-700">{t('calc.extrasHint')}</p>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {EXTRAS.map((extra) => (
                <label
                  key={extra}
                  className="flex min-h-11 items-center gap-2 rounded-md border border-slate-300 bg-white p-2"
                >
                  <input
                    type="checkbox"
                    checked={form.extras.includes(extra)}
                    onChange={(e) =>
                      set(
                        'extras',
                        e.target.checked
                          ? [...form.extras, extra]
                          : form.extras.filter((x) => x !== extra),
                      )
                    }
                    className={`size-4 ${focusRing}`}
                  />
                  {t(`calc.extras.${extra}`)}
                </label>
              ))}
            </div>
          </fieldset>
        </Step>

        <button type="submit" disabled={busy} className={`${buttonPrimary} w-full sm:w-auto`}>
          {busy ? t('calc.calculating') : t('calc.calculate')}
        </button>
        {failure && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 p-3">
            {t(failure)}
          </p>
        )}
      </form>

      {result && <ResultView ref={resultRef} result={result} />}

      <Card title={t('calc.howTitle')}>
        <ul className="list-disc space-y-2 ps-5 text-sm">
          <li>{t('calc.how1')}</li>
          <li>{t('calc.how2')}</li>
          <li>{t('calc.how3')}</li>
          <li>{t('calc.how4')}</li>
        </ul>
      </Card>
    </div>
  );
}
