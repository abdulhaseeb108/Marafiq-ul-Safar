import { LEAD_STATUSES, type LeadStatus, type LeadSummary, type Paged } from '@marafiq/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Alert, Button, Field, Note, Select, Table, errorText } from './ui';

const PAGE_SIZE = 25;

/** Staff lead list (docs/01 section 6.6): filters, search, newest first. */
export function LeadsPage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [assigned, setAssigned] = useState<'' | 'me' | 'unassigned'>('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<LeadSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status) params.set('status', status);
    if (assigned) params.set('assigned', assigned);
    if (q) params.set('q', q);
    try {
      setData(await api<Paged<LeadSummary>>(`/admin/leads?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [status, assigned, q, page, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function find(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQ(search.trim());
  }

  const date = (at: string) =>
    new Intl.DateTimeFormat(i18n.language === 'ur' ? 'ur-PK' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Karachi',
      numberingSystem: 'latn',
    }).format(new Date(at));
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('admin.leads.title')}</h1>
      <Note>{t('admin.leads.intro')}</Note>
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Select
          id="l-status"
          label={t('admin.leads.status')}
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value as LeadStatus | '');
          }}
        >
          <option value="">{t('admin.leads.all')}</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`admin.leads.statuses.${s}`)}
            </option>
          ))}
        </Select>
        <Select
          id="l-assigned"
          label={t('admin.leads.assigned')}
          value={assigned}
          onChange={(e) => {
            setPage(1);
            setAssigned(e.target.value as '' | 'me' | 'unassigned');
          }}
        >
          <option value="">{t('admin.leads.anyone')}</option>
          <option value="me">{t('admin.leads.me')}</option>
          <option value="unassigned">{t('admin.leads.unassigned')}</option>
        </Select>
        <form onSubmit={find} className="flex items-end gap-2">
          <div className="flex-1">
            <Field
              id="l-search"
              label={t('admin.leads.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit">{t('admin.leads.find')}</Button>
        </form>
      </div>

      {data && data.items.length === 0 && <p>{t('admin.leads.none')}</p>}
      {data && data.items.length > 0 && (
        <Table
          headers={[
            t('admin.leads.reference'),
            t('admin.leads.name'),
            t('admin.leads.phone'),
            t('admin.leads.status'),
            t('admin.leads.quote'),
            t('admin.leads.assigned'),
            t('admin.leads.received'),
          ]}
        >
          {data.items.map((lead) => (
            <tr key={lead.id} className="border-b border-slate-200">
              <td className="px-3 py-2">
                <Link
                  to={`/admin/leads/${lead.id}`}
                  className="font-medium text-emerald-900 underline"
                >
                  {lead.reference}
                </Link>
              </td>
              <td className="px-3 py-2">{lead.travelerName}</td>
              <td className="px-3 py-2" dir="ltr">
                {lead.phone}
              </td>
              <td className="px-3 py-2">{t(`admin.leads.statuses.${lead.status}`)}</td>
              <td className="px-3 py-2">
                {lead.latestQuote
                  ? t('admin.quotes.versionStatus', {
                      n: lead.latestQuote.version,
                      status: t(`admin.quotes.statuses.${lead.latestQuote.status}`),
                    })
                  : '—'}
              </td>
              <td className="px-3 py-2">{lead.assignedTo?.name ?? '—'}</td>
              <td className="px-3 py-2">{date(lead.createdAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      {data && pages > 1 && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('admin.leads.prev')}
          </Button>
          <span>{t('admin.leads.page', { page, pages })}</span>
          <Button
            variant="secondary"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('admin.leads.next')}
          </Button>
        </div>
      )}
    </div>
  );
}
