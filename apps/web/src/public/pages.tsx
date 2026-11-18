/** The public content pages (docs/01 section 3). The calculator lives in calculator/. */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useCurrency } from './CurrencyContext';
import { formatDay, ltr, money } from './format';
import { CONTACT, PENDING_QUOTE_KEY } from './site';
import {
  Card,
  PageTitle,
  RequestQuoteLink,
  ReviewMarker,
  buttonPrimary,
  buttonSecondary,
  focusRing,
} from './ui';
import { usePublicConfig, usePublicHotels } from './usePublic';
import type { PublicFromPrice, PublicHotel } from '@marafiq/shared';

export function HomePage() {
  const { t } = useTranslation();
  const services = ['umrah', 'hotels', 'flights', 'visa', 'transport'] as const;
  return (
    <div className="space-y-10">
      <section className="rounded-xl bg-emerald-900 px-5 py-8 text-white sm:px-8 sm:py-12">
        <h1 className="text-2xl font-bold sm:text-4xl">{t('home.title')}</h1>
        <p className="mt-4 max-w-prose text-emerald-50">{t('home.intro')}</p>
        <Link
          to="/umrah"
          className="mt-6 inline-flex min-h-11 items-center rounded-md bg-white px-5 font-semibold text-emerald-900 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {t('home.cta')}
        </Link>
      </section>

      <section aria-labelledby="how">
        <h2 id="how" className="text-xl font-semibold">
          {t('home.howTitle')}
        </h2>
        <ol className="mt-4 grid gap-4 sm:grid-cols-3">
          {(['step1', 'step2', 'step3'] as const).map((step, index) => (
            <li key={step} className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold text-emerald-900">{index + 1}</p>
              <p className="mt-1">{t(`home.${step}`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="services">
        <h2 id="services" className="text-xl font-semibold">
          {t('home.servicesTitle')}
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <li key={service}>
              <Link
                to={`/${service}`}
                className={`block h-full rounded-lg border border-slate-200 bg-white p-4 hover:border-emerald-700 ${focusRing}`}
              >
                <span className="font-semibold text-emerald-900">{t(`site.nav.${service}`)}</span>
                <span className="mt-1 block text-sm text-slate-700">
                  {t(`home.service.${service}`)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <Card title={t('home.honestTitle')}>
        <ul className="list-disc space-y-2 ps-5">
          <li>{t('home.honest1')}</li>
          <li>{t('home.honest2')}</li>
          <li>{t('home.honest3')}</li>
        </ul>
      </Card>
    </div>
  );
}

function FromPrice({ price, unit }: { price: PublicFromPrice; unit: string }) {
  const { t, i18n } = useTranslation();
  const { primary } = useCurrency();
  const pkr = price.minorPKR === null ? null : money('PKR', price.minorPKR);
  const sar = price.minorSAR === null ? null : money('SAR', price.minorSAR);
  const [first, second] = primary === 'SAR' && sar ? [sar, pkr] : [pkr ?? sar, pkr ? sar : null];
  return (
    <p>
      <span className="font-semibold">
        {t('hotels.from', { price: ltr(first ?? '', i18n.language), unit })}
      </span>
      {second && <span className="text-slate-700"> ({second})</span>}
      <span className="block text-xs text-slate-600">
        {t('hotels.source', {
          supplier: ltr(price.supplierName, i18n.language),
          pack: ltr(price.packName, i18n.language),
          date: price.issueDate ? formatDay(price.issueDate, i18n.language) : '—',
        })}
      </span>
    </p>
  );
}

/**
 * Stands in for the hotel list while it loads: the same sections, card classes
 * and text sizes as the real list, so the notice and footer below it do not
 * jump when the hotels arrive (Lighthouse CLS). Height comes from the content,
 * not a fixed number, so it follows the font size and screen width.
 */
function HotelsSkeleton({ label }: { label: string }) {
  const bar = 'block rounded bg-slate-200 motion-safe:animate-pulse';
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-hidden="true" className="space-y-6">
        {[0, 1].map((section) => (
          <div key={section}>
            <span className={`${bar} mb-3 h-7 w-32`} />
            <ul className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((card) => (
                <li key={card} className="rounded-lg border border-slate-200 bg-white p-4">
                  <span className={`${bar} h-6 w-3/4`} />
                  <span className={`${bar} mt-1 h-5 w-1/2`} />
                  <span className="mt-2 block space-y-1">
                    <span className={`${bar} h-5 w-2/3`} />
                    <span className={`${bar} h-4 w-1/2`} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function HotelCard({ hotel }: { hotel: PublicHotel }) {
  const { t, i18n } = useTranslation();
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-semibold" lang="en" dir="auto">
        {hotel.name}
      </h3>
      <p className="text-sm text-slate-700">
        {hotel.distanceNote ||
          (hotel.distanceMeters !== null
            ? t('hotels.distance', {
                meters: ltr(hotel.distanceMeters.toLocaleString('en-US'), i18n.language),
              })
            : t('hotels.distanceUnknown'))}
        {' · '}
        {t(`hotels.transport.${hotel.transport}`)}
      </p>
      <div className="mt-2 space-y-1 text-sm">
        {hotel.onRequestOnly && <p className="font-semibold">{t('calc.requestQuote')}</p>}
        {hotel.fromPerPerson && (
          <FromPrice price={hotel.fromPerPerson} unit={t('hotels.perPersonNight')} />
        )}
        {hotel.fromPerRoom && (
          <FromPrice price={hotel.fromPerRoom} unit={t('hotels.perRoomNight')} />
        )}
        <p className="text-xs text-slate-600">
          {t('hotels.ratesFor', {
            from: formatDay(hotel.ratesFrom, i18n.language),
            to: formatDay(hotel.ratesTo, i18n.language),
          })}
        </p>
      </div>
    </li>
  );
}

export function HotelsPage() {
  const { t } = useTranslation();
  const hotels = usePublicHotels();
  return (
    <div className="space-y-6">
      <PageTitle title={t('hotels.title')} intro={t('hotels.intro')} />
      {hotels.status === 'loading' && <HotelsSkeleton label={t('site.loading')} />}
      {hotels.status === 'error' && <p role="alert">{t('site.loadError')}</p>}
      {hotels.status === 'ready' && hotels.data.items.length === 0 && <p>{t('hotels.none')}</p>}
      {hotels.status === 'ready' &&
        (['makkah', 'madinah'] as const).map((city) => {
          const list = hotels.data.items.filter((h) => h.city === city);
          if (list.length === 0) return null;
          return (
            <section key={city} aria-labelledby={`city-${city}`}>
              <h2 id={`city-${city}`} className="mb-3 text-xl font-semibold">
                {t(`calc.city.${city}`)}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {list.map((hotel) => (
                  <HotelCard key={hotel.id} hotel={hotel} />
                ))}
              </ul>
            </section>
          );
        })}
      <p className="text-sm text-slate-700">{t('site.ratesNotice')}</p>
      <RequestQuoteLink topic="hotels" />
    </div>
  );
}

export function FlightsPage() {
  const { t } = useTranslation();
  const config = usePublicConfig();
  const cities = config.status === 'ready' ? config.data.departureCities : [];
  return (
    <div className="space-y-6">
      <PageTitle title={t('flights.title')} intro={t('flights.intro')} />
      <Card>
        <p>{t('flights.estimates')}</p>
        {cities.length > 0 ? (
          <p className="mt-2 font-semibold">{cities.join(' · ')}</p>
        ) : (
          config.status === 'ready' && <p className="mt-2">{t('flights.noEstimates')}</p>
        )}
        <p className="mt-3 text-sm text-slate-700">{t('flights.notAFare')}</p>
      </Card>
      <RequestQuoteLink topic="flights" />
    </div>
  );
}

export function VisaPage() {
  const { t } = useTranslation();
  const items = ['passport', 'photo', 'cnic', 'tickets', 'hotel', 'vaccination'] as const;
  return (
    <div className="space-y-6">
      <PageTitle title={t('visa.title')} intro={t('visa.intro')} />
      <Card title={t('visa.checklistTitle')}>
        <p className="mb-3">
          <ReviewMarker label="[CLIENT TO CONFIRM]" />
        </p>
        <ul className="list-disc space-y-2 ps-5">
          {items.map((item) => (
            <li key={item}>{t(`visa.items.${item}`)}</li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-slate-700">{t('visa.noUpload')}</p>
      </Card>
      <p className="font-semibold">{t('visa.authority')}</p>
      <RequestQuoteLink topic="visa" />
    </div>
  );
}

export function TransportPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <PageTitle title={t('transport.title')} intro={t('transport.intro')} />
      <Card>
        <p>{t('transport.visaBus')}</p>
      </Card>
      <RequestQuoteLink topic="transport" />
    </div>
  );
}

const FAQ_KEYS = [
  'estimate',
  'requestQuote',
  'expiry',
  'change',
  'currency',
  'documents',
  'booking',
] as const;

export function FaqPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <PageTitle title={t('faq.title')} />
      <div className="space-y-3">
        {FAQ_KEYS.map((key) => (
          <details key={key} className="group rounded-lg border border-slate-200 bg-white">
            <summary
              className={`cursor-pointer list-none rounded-lg p-4 font-semibold ${focusRing}`}
            >
              {t(`faq.items.${key}.q`)}
            </summary>
            <p className="px-4 pb-4 text-slate-800">{t(`faq.items.${key}.a`)}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

const POLICIES = ['privacy', 'terms', 'quote-terms'] as const;
type Policy = (typeof POLICIES)[number];
const POLICY_KEY: Record<Policy, string> = {
  privacy: 'privacy',
  terms: 'terms',
  'quote-terms': 'quoteTerms',
};

export function PolicyPage() {
  const { t } = useTranslation();
  const { policy } = useParams();
  if (!POLICIES.includes(policy as Policy)) return <Navigate to="/" replace />;
  const key = POLICY_KEY[policy as Policy];
  return (
    <div className="space-y-6">
      <PageTitle title={t(`site.policies.${key}`)} />
      <Card>
        <p className="mb-3">
          <ReviewMarker label="[LEGAL REVIEW NEEDED]" />
        </p>
        <p>{t(`policy.${key}`)}</p>
        <p className="mt-3 text-sm text-slate-700">{t('policy.placeholder')}</p>
      </Card>
    </div>
  );
}

function ContactLine({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null;
  href?: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="font-semibold">{label}:</dt>
      <dd>
        {value === null ? (
          <ReviewMarker label="[CLIENT TO PROVIDE]" />
        ) : href ? (
          <a className={`underline ${focusRing}`} href={href} dir="ltr">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

export function ContactPage() {
  const { t } = useTranslation();
  const config = usePublicConfig();
  const [params] = useSearchParams();
  const topic = params.get('topic');
  const [summary, setSummary] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (topic !== 'umrah') return;
    try {
      setSummary(window.sessionStorage.getItem(PENDING_QUOTE_KEY));
    } catch {
      setSummary(null);
    }
  }, [topic]);

  async function copy() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title={t('contact.title')} intro={t('contact.intro')} />
      {topic && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          {t('contact.topic', {
            topic: t(
              `site.nav.${['umrah', 'hotels', 'flights', 'visa', 'transport'].includes(topic) ? topic : 'contact'}`,
            ),
          })}
        </p>
      )}
      {summary && (
        <Card title={t('contact.tripTitle')}>
          <p className="mb-2 text-sm text-slate-700">{t('contact.tripHelp')}</p>
          <pre
            lang="en"
            dir="ltr"
            className="overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-100 p-3 text-sm"
          >
            {summary}
          </pre>
          <button type="button" onClick={() => void copy()} className={`mt-3 ${buttonSecondary}`}>
            {copied ? t('contact.copied') : t('contact.copy')}
          </button>
        </Card>
      )}
      <Card>
        <dl className="space-y-2">
          <ContactLine
            label={t('contact.phone')}
            value={CONTACT.phone}
            href={CONTACT.phone ? `tel:${CONTACT.phone}` : undefined}
          />
          <ContactLine
            label={t('contact.whatsapp')}
            value={CONTACT.whatsapp}
            href={
              CONTACT.whatsapp ? `https://wa.me/${CONTACT.whatsapp.replace(/\D/g, '')}` : undefined
            }
          />
          <ContactLine
            label={t('contact.email')}
            value={CONTACT.email}
            href={CONTACT.email ? `mailto:${CONTACT.email}` : undefined}
          />
          <ContactLine label={t('contact.address')} value={CONTACT.address} />
          <ContactLine label={t('contact.hours')} value={CONTACT.hours} />
        </dl>
        {config.status === 'ready' && config.data.responseTimeText && (
          <p className="mt-4 text-sm text-slate-700">{config.data.responseTimeText}</p>
        )}
      </Card>
      <p className="text-sm text-slate-700">{t('contact.formSoon')}</p>
      <Link to="/umrah" className={buttonPrimary}>
        {t('home.cta')}
      </Link>
    </div>
  );
}
