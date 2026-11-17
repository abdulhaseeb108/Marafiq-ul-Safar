import type { DashboardSummary } from '@marafiq/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './AuthContext';
import { Alert, Button, errorText } from './ui';

const LINK =
  'inline-flex min-h-11 items-center text-sm font-medium text-emerald-900 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800';

/** One dashboard figure with its explanation, its rows and a way into the full page. */
function Card({
  id,
  title,
  count,
  children,
  action,
}: {
  id: string;
  title: string;
  /** Omitted for the card that shows a single item instead of a count. */
  count?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col rounded-lg border border-slate-300 bg-white p-4"
    >
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {count !== undefined && (
        <p className="mt-1 text-3xl font-bold" data-testid={`${id}-count`}>
          {count}
        </p>
      )}
      <div className="mt-2 flex-1 text-sm">{children}</div>
      {action && <div className="mt-2">{action}</div>}
    </section>
  );
}

/** Staff dashboard (docs/01 section 6.2): the figures come from GET /admin/dashboard. */
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { state } = useAuth();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api<DashboardSummary>('/admin/dashboard'));
      setError(null);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== 'authenticated') return null;

  const locale = i18n.language === 'ur' ? 'ur-PK' : 'en-GB';
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).format(value);
  const dateTime = (at: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Karachi',
      numberingSystem: 'latn',
    }).format(new Date(at));
  // Pack dates are calendar dates ("YYYY-MM-DD"), not moments: format them as such.
  const day = (date: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: 'UTC',
      numberingSystem: 'latn',
    }).format(new Date(`${date}T00:00:00Z`));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">
        {t('admin.dashboard.title', { name: state.user.name })}
      </h1>

      {error && (
        <div className="space-y-2">
          <Alert>{t('admin.dashboard.loadFailed', { reason: error })}</Alert>
          <Button variant="secondary" onClick={() => void load()} disabled={busy}>
            {t('admin.dashboard.retry')}
          </Button>
        </div>
      )}

      {!data && !error && <p>{t('admin.common.loading')}</p>}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card
              id="dash-new-leads"
              title={t('admin.dashboard.newLeads.title')}
              count={number(data.leads.newCount)}
              action={
                <Link to="/admin/leads?status=new" className={LINK}>
                  {t('admin.dashboard.newLeads.link')}
                </Link>
              }
            >
              <p className="text-slate-700">{t('admin.dashboard.newLeads.hint')}</p>
            </Card>

            {data.quotes && (
              <Card
                id="dash-quotes"
                title={t('admin.dashboard.quotes.title', { hours: data.quotes.windowHours })}
                count={number(data.quotes.expiringCount)}
                action={
                  <Link to="/admin/leads?status=quote_sent" className={LINK}>
                    {t('admin.dashboard.quotes.link')}
                  </Link>
                }
              >
                {data.quotes.expiring.length === 0 ? (
                  <p className="text-slate-700">
                    {t('admin.dashboard.quotes.empty', { hours: data.quotes.windowHours })}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200">
                    {data.quotes.expiring.map((quote) => (
                      <li key={quote.quoteId} className="py-1">
                        <Link to={`/admin/quotes/${quote.quoteId}`} className={LINK}>
                          {t('admin.dashboard.quotes.item', {
                            reference: quote.leadReference,
                            version: quote.version,
                          })}
                        </Link>
                        <p className="text-slate-700">
                          {t('admin.dashboard.quotes.expires', { at: dateTime(quote.expiresAt) })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {data.quotes.expiringCount > data.quotes.expiring.length && (
                  <p className="mt-1 text-slate-700">
                    {t('admin.dashboard.more', {
                      count: data.quotes.expiringCount - data.quotes.expiring.length,
                    })}
                  </p>
                )}
              </Card>
            )}

            {data.rates && (
              <Card
                id="dash-packs"
                title={t('admin.dashboard.packs.title', { days: data.rates.windowDays })}
                count={number(data.rates.expiringCount)}
                action={
                  <Link to="/admin/rate-sheets" className={LINK}>
                    {t('admin.dashboard.packs.link')}
                  </Link>
                }
              >
                {data.rates.expiring.length === 0 ? (
                  <p className="text-slate-700">
                    {t('admin.dashboard.packs.empty', { days: data.rates.windowDays })}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200">
                    {data.rates.expiring.map((pack) => (
                      <li key={pack.packageId} className="py-1">
                        <Link to={`/admin/rate-sheets/${pack.packageId}`} className={LINK}>
                          {t('admin.dashboard.packs.item', {
                            pack: pack.packName,
                            supplier: pack.supplierName,
                          })}
                        </Link>
                        <p className="text-slate-700">
                          {t('admin.dashboard.packs.lastNight', {
                            date: day(pack.nightTo),
                            version: pack.version,
                          })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {data.rates.expiringCount > data.rates.expiring.length && (
                  <p className="mt-1 text-slate-700">
                    {t('admin.dashboard.more', {
                      count: data.rates.expiringCount - data.rates.expiring.length,
                    })}
                  </p>
                )}
              </Card>
            )}

            {data.rates && (
              <Card id="dash-published" title={t('admin.dashboard.published.title')}>
                {data.rates.lastPublished ? (
                  <>
                    <Link
                      to={`/admin/rate-sheets/${data.rates.lastPublished.packageId}`}
                      className={LINK}
                    >
                      {t('admin.dashboard.published.item', {
                        pack: data.rates.lastPublished.packName,
                        supplier: data.rates.lastPublished.supplierName,
                      })}
                    </Link>
                    <p className="text-slate-700">
                      {t('admin.dashboard.published.detail', {
                        version: data.rates.lastPublished.version,
                        at: dateTime(data.rates.lastPublished.publishedAt),
                      })}
                    </p>
                    {data.rates.lastPublished.status !== 'published' && (
                      <p className="text-slate-700">{t('admin.dashboard.published.replaced')}</p>
                    )}
                  </>
                ) : (
                  <p className="text-slate-700">{t('admin.dashboard.published.empty')}</p>
                )}
              </Card>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
            <p>{t('admin.dashboard.asOf', { at: dateTime(data.generatedAt) })}</p>
            <Button variant="secondary" onClick={() => void load()} disabled={busy}>
              {t('admin.dashboard.refresh')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
