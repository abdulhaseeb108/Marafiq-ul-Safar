/**
 * The quote request form (docs/01 section 5). From the calculator it carries
 * the trip; the server prices it again and stores its own snapshot. We ask
 * for contact details only: never passport, CNIC or card numbers.
 */
import {
  CONSENT_TEXT_VERSION,
  INQUIRY_SOURCES,
  normalizePkMobile,
  type CalculationResult,
  type InquiryBody,
  type InquiryResponse,
  type InquirySource,
  type Language,
} from '@marafiq/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiRequestError, api } from '../lib/api';
import { useCurrency } from './CurrencyContext';
import { formatDay, money } from './format';
import { PENDING_TRIP_KEY } from './site';
import { Card, PageTitle, buttonPrimary, focusRing } from './ui';

const input = `mt-1 block min-h-11 w-full rounded-md border border-slate-500 bg-white px-3 ${focusRing}`;
const SERVER = 'server:';

function storedTrip(): CalculationResult | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_TRIP_KEY);
    return raw ? (JSON.parse(raw) as CalculationResult) : null;
  } catch {
    return null;
  }
}

function TripCard({ trip }: { trip: CalculationResult }) {
  const { t, i18n } = useTranslation();
  const { primary } = useCurrency();
  const { inputs, totals } = trip;
  const total =
    primary === 'SAR'
      ? `${money('SAR', totals.groupMinorSAR)} (${money('PKR', totals.groupMinorPKR)})`
      : `${money('PKR', totals.groupMinorPKR)} (${money('SAR', totals.groupMinorSAR)})`;
  return (
    <Card title={t('inquiry.tripTitle')}>
      <ul className="space-y-1 text-sm">
        <li>{t('inquiry.tripArrival', { date: formatDay(inputs.arrivalDate, i18n.language) })}</li>
        <li>
          {t('inquiry.tripNights', { makkah: inputs.nightsMakkah, madinah: inputs.nightsMadinah })}
        </li>
        <li>
          {t('inquiry.tripTravelers', {
            adults: inputs.travelers.adults,
            children: inputs.travelers.children,
            infants: inputs.travelers.infants,
          })}
        </li>
        <li className="font-semibold">
          {totals.isPartial && trip.missing.length > 0 ? t('calc.totalPartial') : t('calc.total')}:{' '}
          <span dir="ltr">{total}</span>
        </li>
      </ul>
      <p className="mt-2 text-sm text-slate-700">{t('inquiry.tripNote')}</p>
    </Card>
  );
}

export function InquiryPage() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const topicParam = params.get('topic') ?? 'contact';
  const source: InquirySource = (INQUIRY_SOURCES as readonly string[]).includes(topicParam)
    ? (topicParam as InquirySource)
    : 'contact';
  const [trip] = useState(() => (source === 'umrah' ? storedTrip() : null));

  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    language: (i18n.language === 'ur' ? 'ur' : 'en') as Language,
    notes: '',
    consent: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [errorTurn, setErrorTurn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<InquiryResponse | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (errorTurn > 0) summaryRef.current?.focus();
  }, [errorTurn]);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!form.name.trim()) found['traveler.name'] = 'inquiry.errors.name';
    if (!normalizePkMobile(form.phone)) found['traveler.phone'] = 'inquiry.errors.phone';
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      found['traveler.email'] = 'inquiry.errors.email';
    }
    if (!form.consent) found['consent.accepted'] = 'inquiry.errors.consent';
    return found;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setErrorTurn((n) => n + 1);
      return;
    }
    const body: InquiryBody = {
      source,
      traveler: { name: form.name, phone: form.phone, email: form.email, language: form.language },
      notes: form.notes,
      consent: { accepted: true, textVersion: CONSENT_TEXT_VERSION },
      ...(trip ? { inputs: trip.inputs } : {}),
    };
    setBusy(true);
    try {
      const response = await api<InquiryResponse>('/public/inquiries', {
        method: 'POST',
        body,
        retryOn401: false,
      });
      try {
        window.sessionStorage.removeItem(PENDING_TRIP_KEY);
      } catch {
        // nothing to clear
      }
      setDone(response);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'validation_error' && error.fields) {
        setErrors(
          Object.fromEntries(Object.entries(error.fields).map(([k, v]) => [k, `${SERVER}${v}`])),
        );
        setErrorTurn((n) => n + 1);
      } else {
        setFailure('site.loadError');
      }
    } finally {
      setBusy(false);
    }
  }

  const message = (key: string) => (key.startsWith(SERVER) ? key.slice(SERVER.length) : t(key));
  const fieldProps = (path: string) => ({
    id: `f-${path.replace(/\./g, '-')}`,
    'aria-invalid': errors[path] ? true : undefined,
    'aria-describedby': errors[path] ? `f-${path.replace(/\./g, '-')}-error` : undefined,
  });
  const ErrorText = ({ path }: { path: string }) =>
    errors[path] ? (
      <p
        id={`f-${path.replace(/\./g, '-')}-error`}
        className="mt-1 text-sm font-semibold text-red-800"
      >
        {message(errors[path])}
      </p>
    ) : null;

  if (done) {
    return (
      <div className="space-y-6">
        <h1 ref={doneRef} tabIndex={-1} className="text-2xl font-bold sm:text-3xl">
          {done.duplicate ? t('inquiry.duplicateTitle') : t('inquiry.doneTitle')}
        </h1>
        <Card>
          <p>{t('inquiry.yourReference')}</p>
          <p className="mt-1 text-2xl font-bold tracking-wide" dir="ltr" lang="en">
            {done.reference}
          </p>
          <p className="mt-3">
            {done.duplicate ? t('inquiry.duplicateBody') : t('inquiry.doneBody')}
          </p>
          {done.responseTimeText && <p className="mt-2 font-semibold">{done.responseTimeText}</p>}
          <p className="mt-3 text-sm text-slate-700">{t('inquiry.keepReference')}</p>
        </Card>
        <Link to="/" className={buttonPrimary}>
          {t('inquiry.backHome')}
        </Link>
      </div>
    );
  }

  const errorList = Object.entries(errors);
  return (
    <div className="space-y-6">
      <PageTitle title={t('inquiry.title')} intro={t('inquiry.intro')} />
      {trip && <TripCard trip={trip} />}

      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4">
        {errorList.length > 0 && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border-2 border-red-700 bg-red-50 p-4"
          >
            <p className="font-semibold">{t('calc.errors.summary')}</p>
            <ul className="mt-2 list-disc ps-5">
              {errorList.map(([path, key]) => (
                <li key={path}>
                  <a href={`#f-${path.replace(/\./g, '-')}`} className={`underline ${focusRing}`}>
                    {message(key)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Card>
          <div className="space-y-4">
            <div>
              <label htmlFor="f-traveler-name" className="font-medium">
                {t('inquiry.name')}
              </label>
              <input
                {...fieldProps('traveler.name')}
                autoComplete="name"
                maxLength={100}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className={input}
              />
              <ErrorText path="traveler.name" />
            </div>
            <div>
              <label htmlFor="f-traveler-phone" className="font-medium">
                {t('inquiry.phone')}
              </label>
              <p id="phone-hint" className="text-sm text-slate-700">
                {t('inquiry.phoneHint')}
              </p>
              <input
                {...fieldProps('traveler.phone')}
                aria-describedby={[
                  'phone-hint',
                  errors['traveler.phone'] ? 'f-traveler-phone-error' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={30}
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                className={input}
                dir="ltr"
              />
              <ErrorText path="traveler.phone" />
            </div>
            <div>
              <label htmlFor="f-traveler-email" className="font-medium">
                {t('inquiry.email')}
              </label>
              <input
                {...fieldProps('traveler.email')}
                type="email"
                autoComplete="email"
                maxLength={200}
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                className={input}
                dir="ltr"
              />
              <ErrorText path="traveler.email" />
            </div>
            <fieldset>
              <legend className="font-medium">{t('inquiry.language')}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {(['en', 'ur'] as const).map((lang) => (
                  <label
                    key={lang}
                    className="flex min-h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3"
                  >
                    <input
                      type="radio"
                      name="language"
                      checked={form.language === lang}
                      onChange={() => set('language', lang)}
                      className={`size-4 ${focusRing}`}
                    />
                    <span lang={lang}>{lang === 'en' ? 'English' : 'اردو'}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor="f-notes" className="font-medium">
                {t('inquiry.notes')}
              </label>
              <p id="notes-hint" className="text-sm text-slate-700">
                {t('inquiry.notesHint')}
              </p>
              <textarea
                id="f-notes"
                aria-describedby="notes-hint"
                rows={4}
                maxLength={2000}
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                className={`mt-1 block w-full rounded-md border border-slate-500 bg-white px-3 py-2 ${focusRing}`}
              />
            </div>
            <div>
              <label className="flex items-start gap-3">
                <input
                  {...fieldProps('consent.accepted')}
                  type="checkbox"
                  checked={form.consent}
                  onChange={(e) => set('consent', e.target.checked)}
                  className={`mt-1 size-5 shrink-0 ${focusRing}`}
                />
                <span>
                  <Trans
                    i18nKey="inquiry.consent"
                    components={{
                      privacy: <Link to="/policies/privacy" className={`underline ${focusRing}`} />,
                    }}
                  />
                </span>
              </label>
              <ErrorText path="consent.accepted" />
            </div>
          </div>
        </Card>

        <button type="submit" disabled={busy} className={`${buttonPrimary} w-full sm:w-auto`}>
          {busy ? t('inquiry.sending') : t('inquiry.submit')}
        </button>
        {failure && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 p-3">
            {t(failure)}
          </p>
        )}
      </form>
    </div>
  );
}
