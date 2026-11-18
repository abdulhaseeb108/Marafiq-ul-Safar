/**
 * The customer's private quote page, /q/:token (docs/01 sections 5 and 7).
 * Status words come only from the shared wording map (customerQuoteStatusLabel),
 * so "booked" can never appear. Accepting is a request, not a booking.
 */
import {
  customerQuoteStatusLabel,
  type Language,
  type PublicQuoteView,
  type QuoteLineView,
} from '@marafiq/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiRequestError, api } from '../lib/api';
import { useCurrency } from './CurrencyContext';
import { formatMoment, money } from './format';
import { Card, buttonPrimary, buttonSecondary, focusRing } from './ui';

type Load =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error' }
  | { status: 'ready'; quote: PublicQuoteView };

const STATUS_STYLE: Record<PublicQuoteView['status'], string> = {
  sent: 'border-emerald-700 bg-emerald-50 text-emerald-900',
  accepted: 'border-emerald-700 bg-emerald-100 text-emerald-900',
  declined: 'border-slate-400 bg-slate-100 text-slate-900',
  expired: 'border-amber-500 bg-amber-50 text-amber-900',
  replaced: 'border-amber-500 bg-amber-50 text-amber-900',
};

/** Keep quote links out of search engines. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

function LineRow({ line }: { line: QuoteLineView }) {
  const { t } = useTranslation();
  const { primary } = useCurrency();
  const other =
    line.currency === 'SAR' ? money('PKR', line.amountMinorPKR) : money('SAR', line.amountMinorSAR);
  const own = money(line.currency, line.amountMinor);
  const [first, second] = primary === line.currency ? [own, other] : [other, own];
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-slate-200 py-3 last:border-b-0">
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-semibold" dir="auto">
          {line.description}
        </p>
        <p className="text-sm" dir="ltr">
          {line.quantity} × {money(line.currency, line.unitAmountMinor)}
        </p>
        <p className="text-xs text-slate-600">
          {t('quote.supplier')}: <bdi>{line.supplier}</bdi>
        </p>
        {line.notes && (
          <p className="text-xs text-slate-600" dir="auto">
            {line.notes}
          </p>
        )}
      </div>
      <span className="text-end" dir="ltr">
        <span className="block font-semibold">{first}</span>
        <span className="block text-sm text-slate-600">{second}</span>
      </span>
    </li>
  );
}

export function QuotePage() {
  const { t, i18n } = useTranslation();
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const follow = params.get('v') === 'latest';
  const query = follow ? '?follow=latest' : '';
  const { primary } = useCurrency();
  const language: Language = i18n.language === 'ur' ? 'ur' : 'en';

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  useNoIndex();

  const fetchQuote = useCallback(async () => {
    try {
      const quote = await api<PublicQuoteView>(
        `/public/quotes/${encodeURIComponent(token)}${query}`,
        { retryOn401: false },
      );
      setLoad({ status: 'ready', quote });
    } catch (error) {
      setLoad({
        status: error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'error',
      });
    }
  }, [token, query]);

  useEffect(() => {
    setLoad({ status: 'loading' });
    void fetchQuote();
  }, [fetchQuote]);

  async function accept() {
    setBusy(true);
    setActionError(null);
    try {
      const quote = await api<PublicQuoteView>(
        `/public/quotes/${encodeURIComponent(token)}/accept${query}`,
        {
          method: 'POST',
          retryOn401: false,
        },
      );
      setLoad({ status: 'ready', quote });
      setConfirming(false);
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (error) {
      // The lead was accepted through another quote: this one still shows as
      // sent, so "expired or replaced" would be the wrong thing to say.
      const elsewhere = error instanceof ApiRequestError && error.code === 'quote_other_accepted';
      setActionError(elsewhere ? 'quote.acceptedElsewhere' : 'quote.acceptFailed');
      await fetchQuote();
    } finally {
      setBusy(false);
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) {
      setActionError('quote.questionEmpty');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api(`/public/quotes/${encodeURIComponent(token)}/message${query}`, {
        method: 'POST',
        body: { body: question },
        retryOn401: false,
      });
      setAsked(true);
      setQuestion('');
    } catch {
      setActionError('site.loadError');
    } finally {
      setBusy(false);
    }
  }

  if (load.status === 'loading') return <p role="status">{t('site.loading')}</p>;
  if (load.status === 'missing' || load.status === 'error') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">
          {t(load.status === 'missing' ? 'quote.notFoundTitle' : 'quote.errorTitle')}
        </h1>
        <p>{t(load.status === 'missing' ? 'quote.notFoundBody' : 'site.loadError')}</p>
        <Link to="/contact" className={buttonSecondary}>
          {t('site.nav.contact')}
        </Link>
      </div>
    );
  }

  const { quote } = load;
  const label = customerQuoteStatusLabel(quote.status, language);
  const totals =
    primary === 'SAR'
      ? [money('SAR', quote.totals.totalMinorSAR), money('PKR', quote.totals.totalMinorPKR)]
      : [money('PKR', quote.totals.totalMinorPKR), money('SAR', quote.totals.totalMinorSAR)];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">{t('quote.title')}</h1>
        <p className="mt-1 text-slate-700">
          {t('quote.reference')}: <span dir="ltr">{quote.reference}</span> ·{' '}
          {t('quote.version', { n: quote.version })}
        </p>
        {quote.travelerName && (
          <p className="text-slate-700">{t('quote.preparedFor', { name: quote.travelerName })}</p>
        )}
      </div>

      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        className={`rounded-md border-2 px-4 py-3 text-lg font-semibold ${STATUS_STYLE[quote.status]}`}
      >
        {label}
      </p>

      {quote.viaOlderLink && <p className="text-sm text-slate-700">{t('quote.viaOlderLink')}</p>}
      {quote.status === 'replaced' && quote.hasNewerVersion && (
        <Link to={`/q/${token}?v=latest`} className={buttonPrimary}>
          {t('quote.viewNewVersion')}
        </Link>
      )}
      {quote.status === 'expired' && (
        <Link to="/request-quote?topic=umrah" className={buttonPrimary}>
          {t('site.requestQuote')}
        </Link>
      )}

      <Card>
        <h2 className="text-lg font-semibold">{t('quote.items')}</h2>
        <ul>
          {quote.lineItems.map((line, index) => (
            <LineRow key={index} line={line} />
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-t-2 border-slate-300 pt-3">
          <p className="font-semibold">{t('quote.total')}</p>
          <span className="text-end" dir="ltr">
            <span className="block text-xl font-bold">{totals[0]}</span>
            <span className="block text-sm text-slate-600">{totals[1]}</span>
          </span>
        </div>
        <p className="mt-3 text-sm font-semibold">{t('site.ratesNotice')}</p>
        <p className="text-sm">
          {t('quote.validUntil', { at: formatMoment(quote.expiresAt, i18n.language) })}
        </p>
        <p className="text-xs text-slate-600">
          {t('quote.fx', {
            rate:
              i18n.language === 'ur'
                ? `⁦1 SAR = PKR ${quote.fx.rate}⁩`
                : `1 SAR = PKR ${quote.fx.rate}`,
            at: formatMoment(quote.sentAt, i18n.language),
          })}
        </p>
      </Card>

      {quote.exclusions.length > 0 && (
        <Card title={t('quote.exclusions')}>
          <ul className="list-disc space-y-1 ps-5 text-sm" dir="auto">
            {quote.exclusions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </Card>
      )}
      {quote.terms && (
        <Card title={t('quote.terms')}>
          <p className="whitespace-pre-line text-sm" dir="auto">
            {quote.terms}
          </p>
        </Card>
      )}

      {actionError && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 p-3">
          {t(actionError)}
        </p>
      )}

      {quote.canAccept && (
        <Card title={t('quote.acceptTitle')}>
          <p className="text-sm">{t('quote.acceptExplain')}</p>
          {confirming ? (
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void accept()}
                className={buttonPrimary}
              >
                {t('quote.acceptConfirm')}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={buttonSecondary}
              >
                {t('quote.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={`mt-3 ${buttonPrimary}`}
            >
              {t('quote.accept')}
            </button>
          )}
        </Card>
      )}

      <Card title={t('quote.askTitle')}>
        {asked ? (
          <p role="status">{t('quote.asked')}</p>
        ) : (
          <form onSubmit={(e) => void ask(e)} noValidate>
            <label htmlFor="q-question" className="font-medium">
              {t('quote.askLabel')}
            </label>
            <textarea
              id="q-question"
              rows={4}
              maxLength={2000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className={`mt-1 block w-full rounded-md border border-slate-500 bg-white px-3 py-2 ${focusRing}`}
            />
            <button type="submit" disabled={busy} className={`mt-3 ${buttonSecondary}`}>
              {t('quote.askSend')}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
