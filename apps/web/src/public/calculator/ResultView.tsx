/**
 * The estimate screen (docs/01 section 4, output). Every price shows supplier,
 * pack, sheet issue date and currency; missing pieces say "Request a quote"
 * and are not in the totals; partial totals are labelled.
 */
import type { CalculationResult, FlightLine, HotelLine, LineItem, VisaLine } from '@marafiq/shared';
import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useCurrency } from '../CurrencyContext';
import { formatDay, formatMoment, ltr, money } from '../format';
import { PENDING_QUOTE_KEY } from '../site';
import { buttonPrimary } from '../ui';
import { noteText } from './notes';

function Amount({ sar, pkr, strong = false }: { sar: number; pkr: number; strong?: boolean }) {
  const { primary } = useCurrency();
  const [first, second] =
    primary === 'SAR'
      ? [money('SAR', sar), money('PKR', pkr)]
      : [money('PKR', pkr), money('SAR', sar)];
  return (
    <span className="text-end" dir="ltr">
      <span className={strong ? 'block text-xl font-bold' : 'block font-semibold'}>{first}</span>
      <span className="block text-sm text-slate-600">{second}</span>
    </span>
  );
}

function Source({ line }: { line: HotelLine | VisaLine }) {
  const { t, i18n } = useTranslation();
  return (
    <p className="text-xs text-slate-600">
      {t('calc.source', {
        supplier: ltr(line.source.supplierName, i18n.language),
        pack: ltr(line.source.packName, i18n.language),
        date: line.source.issueDate ? formatDay(line.source.issueDate, i18n.language) : '—',
      })}
    </p>
  );
}

function HotelRow({ line }: { line: HotelLine }) {
  const { t, i18n } = useTranslation();
  const dates =
    line.firstNight === line.lastNight
      ? formatDay(line.firstNight, i18n.language)
      : t('calc.dateRange', {
          from: formatDay(line.firstNight, i18n.language),
          to: formatDay(line.lastNight, i18n.language),
        });
  const unit = ltr(money('SAR', line.unitMinorSAR), i18n.language);
  return (
    <>
      <p className="font-semibold">
        <span lang="en" dir="auto">
          {line.hotelName}
        </span>{' '}
        <span className="font-normal text-slate-700">({t(`calc.city.${line.city}`)})</span>
      </p>
      <p className="text-sm">{t('calc.nightsOn', { count: line.nights, dates })}</p>
      <p className="text-sm">
        {line.basis === 'per_person'
          ? t('calc.perPersonLine', {
              occupancy: t(`calc.occupancy.${line.occupancy}`),
              persons: line.persons,
              rooms: line.rooms,
              unit,
            })
          : t('calc.perRoomLine', { rooms: line.rooms, unit })}
      </p>
      <Source line={line} />
    </>
  );
}

function VisaRow({ line }: { line: VisaLine }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <p className="font-semibold">{t(`calc.visaLine.${line.visa}`)}</p>
      <p className="text-sm">
        {t('calc.visaUnits', {
          persons: line.persons,
          unit: ltr(money('SAR', line.unitMinorSAR), i18n.language),
        })}
      </p>
      <Source line={line} />
    </>
  );
}

function FlightRow({ line }: { line: FlightLine }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      <p className="font-semibold">
        {t('calc.flightLine', {
          city: ltr(line.originCity, i18n.language),
          airport: ltr(line.destination, i18n.language),
        })}
      </p>
      <p className="text-sm">
        {t('calc.flightUnits', {
          adults: line.adults,
          low: ltr(money('PKR', line.lowPerAdultMinorPKR), i18n.language),
          high: ltr(money('PKR', line.highPerAdultMinorPKR), i18n.language),
        })}
      </p>
      <p className="text-xs text-slate-600">
        {t('calc.flightSource', { date: formatDay(line.validTo, i18n.language) })}
      </p>
    </>
  );
}

function LineRow({ line }: { line: LineItem }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-slate-200 py-3 last:border-b-0">
      <div className="min-w-0 flex-1 basis-56">
        {line.kind === 'hotel' && <HotelRow line={line} />}
        {line.kind === 'visa' && <VisaRow line={line} />}
        {line.kind === 'flight' && <FlightRow line={line} />}
      </div>
      {line.kind === 'flight' ? (
        <span className="font-semibold" dir="ltr">
          {money('PKR', line.lowMinorPKR)} – {money('PKR', line.highMinorPKR)}
        </span>
      ) : (
        <Amount sar={line.amountMinorSAR} pkr={line.amountMinorPKR} />
      )}
    </li>
  );
}

/** A plain-text trip summary for staff (English), passed to the Contact page. */
export function tripSummary(result: CalculationResult): string {
  const i = result.inputs;
  const lines = [
    `Umrah estimate ${result.hash.slice(0, 10)}`,
    `Arrival ${i.arrivalDate}${i.flexibilityDays ? ` (±${i.flexibilityDays} days)` : ''}, from ${i.departureCity || 'not given'}`,
    `Makkah ${i.nightsMakkah} nights, Madinah ${i.nightsMadinah} nights, ${i.order === 'makkah_first' ? 'Makkah first' : 'Madinah first'}`,
    `Travelers: ${i.travelers.adults} adults, ${i.travelers.children} children, ${i.travelers.infants} infants`,
    `Rooms: ${i.rooms.map((r) => `${r.occupancy} (${r.persons})`).join(', ')}`,
    ...result.lineItems.map((l) =>
      l.kind === 'flight'
        ? `${l.label}: PKR ${l.lowMinorPKR / 100}–${l.highMinorPKR / 100}`
        : `${l.label}: SAR ${l.amountMinorSAR / 100} / PKR ${l.amountMinorPKR / 100}`,
    ),
    ...result.missing.map((m) => `Request a quote: ${m.message}`),
    `Total priced items: SAR ${result.totals.groupMinorSAR / 100} / PKR ${result.totals.groupMinorPKR / 100}`,
    `Visa: ${i.visa}; flights: ${i.flight === 'self' ? 'own arrangement' : 'estimate'}`,
    `Valid until ${new Date(result.expiresAt).toISOString()}`,
  ];
  return lines.join('\n');
}

export const ResultView = forwardRef<HTMLHeadingElement, { result: CalculationResult }>(
  function ResultView({ result }, headingRef) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const partial = result.missing.length > 0;
    const { totals } = result;

    function requestQuote() {
      try {
        window.sessionStorage.setItem(PENDING_QUOTE_KEY, tripSummary(result));
      } catch {
        // without storage the Contact page just shows no summary
      }
      void navigate('/contact?topic=umrah');
    }

    return (
      <section aria-labelledby="result-title" className="space-y-5">
        <h2
          id="result-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-bold sm:text-2xl"
        >
          {t('calc.resultTitle')}
        </h2>

        <div className="rounded-lg border-2 border-emerald-800 bg-white p-4">
          {partial && (
            <p className="mb-3 rounded-md bg-amber-100 px-3 py-2 font-semibold text-amber-900">
              {t('calc.partialLabel')}
            </p>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="font-semibold">{partial ? t('calc.totalPartial') : t('calc.total')}</p>
            <Amount sar={totals.groupMinorSAR} pkr={totals.groupMinorPKR} strong />
          </div>
          <div className="mt-2 flex flex-wrap items-start justify-between gap-3 border-t border-slate-200 pt-2">
            <p>{t('calc.perPerson', { count: totals.payingPersons })}</p>
            <Amount sar={totals.perPersonMinorSAR} pkr={totals.perPersonMinorPKR} />
          </div>
          {totals.range && (
            <div className="mt-2 border-t border-slate-200 pt-2">
              <p className="font-semibold">{t('calc.withFlight')}</p>
              <p dir="ltr" className="text-end">
                {money('PKR', totals.range.groupLowMinorPKR)} –{' '}
                {money('PKR', totals.range.groupHighMinorPKR)}
              </p>
              <p className="text-sm text-slate-700">
                {t('calc.withFlightPerPerson', {
                  low: ltr(money('PKR', totals.range.perPersonLowMinorPKR), i18n.language),
                  high: ltr(money('PKR', totals.range.perPersonHighMinorPKR), i18n.language),
                })}
              </p>
            </div>
          )}
          <p className="mt-3 text-sm font-semibold">{t('site.ratesNotice')}</p>
          <p className="text-sm">
            {t('calc.expires', { at: formatMoment(result.expiresAt, i18n.language) })}
          </p>
          <p className="text-xs text-slate-600">
            {t('calc.fxUsed', {
              rate: ltr(`1 SAR = PKR ${result.fx.rate}`, i18n.language),
              at: formatMoment(result.calculatedAt, i18n.language),
            })}
          </p>
        </div>

        {result.lineItems.length > 0 && (
          <div>
            <h3 className="mb-1 text-lg font-semibold">{t('calc.lineItems')}</h3>
            <ul className="rounded-lg border border-slate-200 bg-white px-4">
              {result.lineItems.map((line, index) => (
                <LineRow key={index} line={line} />
              ))}
            </ul>
          </div>
        )}

        {partial && (
          <div>
            <h3 className="mb-1 text-lg font-semibold">{t('calc.missingTitle')}</h3>
            <ul className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
              {result.missing.map((item, index) => (
                <li key={index} className="flex flex-wrap justify-between gap-x-4">
                  <span>{noteText(t, i18n.language, item)}</span>
                  <span className="font-semibold">{t('calc.requestQuote')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-lg font-semibold">{t('calc.assumptions')}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {result.assumptions.map((note, index) => (
                <li key={index}>{noteText(t, i18n.language, note)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-lg font-semibold">{t('calc.exclusions')}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {result.exclusions.map((note, index) => (
                <li key={index}>{noteText(t, i18n.language, note)}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="space-y-2">
          <button type="button" onClick={requestQuote} className={buttonPrimary}>
            {t('site.requestQuote')}
          </button>
          <p className="text-sm text-slate-700">{t('calc.requestHelp')}</p>
        </div>
      </section>
    );
  },
);
