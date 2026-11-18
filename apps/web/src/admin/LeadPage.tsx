import { formatMinor, type Assignee, type LeadDetail, type QuoteDetail } from '@marafiq/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiRequestError, api } from './api';
import { useAuth } from './AuthContext';
import { Alert, Button, Note, Section, Select, Table, Textarea, errorText } from './ui';

const MANAGERS = ['admin', 'sales'];

function when(at: string, language: string) {
  return new Intl.DateTimeFormat(language === 'ur' ? 'ur-PK' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
    numberingSystem: 'latn',
  }).format(new Date(at));
}

/** One lead: customer, trip, pipeline, notes, messages and quotes (docs/01 section 6.6). */
export function LeadPage() {
  const { t, i18n } = useTranslation();
  const { leadId = '' } = useParams();
  const navigate = useNavigate();
  const { state } = useAuth();
  const canManage = state.status === 'authenticated' && MANAGERS.includes(state.user.role);

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [reply, setReply] = useState({
    body: '',
    channel: 'whatsapp_manual' as 'whatsapp_manual' | 'email',
  });

  const load = useCallback(async () => {
    try {
      setLead(await api<LeadDetail>(`/admin/leads/${leadId}`));
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [leadId, t]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (canManage)
      void api<{ items: Assignee[] }>('/admin/leads/assignees').then(
        (r) => setAssignees(r.items),
        () => {},
      );
  }, [canManage]);

  async function run(request: () => Promise<LeadDetail | undefined>) {
    setBusy(true);
    setError(null);
    try {
      const next = await request();
      if (next) setLead(next);
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const patch = (body: object) =>
    run(() => api<LeadDetail>(`/admin/leads/${leadId}`, { method: 'PATCH', body }));

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    if (
      await run(() =>
        api<LeadDetail>(`/admin/leads/${leadId}/notes`, { method: 'POST', body: { body: note } }),
      )
    )
      setNote('');
  }

  async function logReply(event: FormEvent) {
    event.preventDefault();
    if (!reply.body.trim()) return;
    if (
      await run(() =>
        api<LeadDetail>(`/admin/leads/${leadId}/messages`, { method: 'POST', body: reply }),
      )
    ) {
      setReply((r) => ({ ...r, body: '' }));
    }
  }

  async function createQuote() {
    setBusy(true);
    setError(null);
    try {
      const quote = await api<QuoteDetail>(`/admin/leads/${leadId}/quotes`, { method: 'POST' });
      void navigate(`/admin/quotes/${quote.id}`);
    } catch (err) {
      const existing = err instanceof ApiRequestError ? err.fields?.existingId : undefined;
      if (existing) void navigate(`/admin/quotes/${existing}`);
      else setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!lead) return error ? <Alert>{error}</Alert> : <p>{t('admin.common.loading')}</p>;
  const trip = lead.tripInputs;
  const whatsapp = `https://wa.me/${lead.traveler.phone.replace(/\D/g, '').replace(/^0/, '92')}`;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm">
          <Link to="/admin/leads" className="underline">
            {t('admin.leads.back')}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">
          {lead.reference} · {t(`admin.leads.statuses.${lead.status}`)}
        </h1>
        <p className="text-sm text-slate-700">
          {t(`admin.leads.sources.${lead.source}`)} · {when(lead.createdAt, i18n.language)}
        </p>
      </div>
      {error && <Alert>{error}</Alert>}

      <Section title={t('admin.leads.customer')}>
        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium">{t('admin.leads.name')}</dt>
          <dd>{lead.traveler.name}</dd>
          <dt className="font-medium">{t('admin.leads.phone')}</dt>
          <dd dir="ltr" className="text-start">
            {lead.traveler.phone} ·{' '}
            <a href={whatsapp} target="_blank" rel="noreferrer" className="underline">
              WhatsApp
            </a>
          </dd>
          <dt className="font-medium">{t('admin.leads.email')}</dt>
          <dd>{lead.traveler.email ?? '—'}</dd>
          <dt className="font-medium">{t('admin.leads.language')}</dt>
          <dd>{lead.traveler.language === 'ur' ? 'اردو' : 'English'}</dd>
          <dt className="font-medium">{t('admin.leads.consent')}</dt>
          <dd>
            {lead.consent.textVersion} · {when(lead.consent.acceptedAt, i18n.language)}
          </dd>
        </dl>
        {lead.notesText && (
          <blockquote className="mt-3 whitespace-pre-line rounded-md border-s-4 border-slate-300 bg-white p-3 text-sm">
            {lead.notesText}
          </blockquote>
        )}
      </Section>

      {trip && (
        <Section title={t('admin.leads.trip')}>
          <p className="mt-2 text-sm">
            {t('admin.leads.tripLine', {
              date: trip.arrivalDate,
              makkah: trip.nightsMakkah,
              madinah: trip.nightsMadinah,
              adults: trip.travelers.adults,
              children: trip.travelers.children,
              infants: trip.travelers.infants,
              from: trip.departureCity || '—',
            })}
          </p>
          <p className="text-sm">
            {t('admin.leads.rooms')}:{' '}
            {trip.rooms.map((r) => `${r.occupancy} (${r.persons})`).join(', ')} ·{' '}
            {t('admin.leads.visa')}: {trip.visa} · {t('admin.leads.flight')}: {trip.flight}
          </p>
          {lead.calculation ? (
            <>
              <p className="mt-2 text-sm font-semibold">
                {t('admin.leads.estimate', {
                  sar: formatMinor(lead.calculation.totals.groupMinorSAR),
                  pkr: formatMinor(lead.calculation.totals.groupMinorPKR),
                })}
              </p>
              {lead.calculation.missing.length > 0 && (
                <ul className="mt-1 list-disc ps-5 text-sm">
                  {lead.calculation.missing.map((m, index) => (
                    <li key={index}>{m.message}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <Note>{t('admin.leads.notPriced')}</Note>
          )}
        </Section>
      )}

      {canManage && (
        <Section title={t('admin.leads.pipeline')}>
          <div className="mt-2 flex flex-wrap gap-2">
            {lead.nextStatuses.map((status) => (
              <Button
                key={status}
                variant="secondary"
                disabled={busy}
                onClick={() => void patch({ status })}
              >
                {t('admin.leads.moveTo', { status: t(`admin.leads.statuses.${status}`) })}
              </Button>
            ))}
          </div>
          <div className="mt-4 max-w-sm">
            <Select
              id="lead-assign"
              label={t('admin.leads.assigned')}
              value={lead.assignedTo?.id ?? ''}
              disabled={busy}
              onChange={(e) => void patch({ assignedTo: e.target.value || null })}
            >
              <option value="">{t('admin.leads.unassigned')}</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
        </Section>
      )}

      {lead.quotes && (
        <Section title={t('admin.quotes.title')}>
          {lead.quotes.length > 0 ? (
            <Table
              headers={[
                t('admin.quotes.version'),
                t('admin.quotes.status'),
                t('admin.quotes.total'),
                t('admin.quotes.expires'),
              ]}
            >
              {lead.quotes.map((q) => (
                <tr key={q.id} className="border-b border-slate-200">
                  <td className="px-3 py-2">
                    <Link
                      to={`/admin/quotes/${q.id}`}
                      className="font-medium text-emerald-900 underline"
                    >
                      {t('admin.quotes.versionN', { n: q.version })}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{t(`admin.quotes.statuses.${q.status}`)}</td>
                  <td className="px-3 py-2" dir="ltr">
                    PKR {formatMinor(q.totalMinorPKR)} · SAR{' '}
                    {formatMinor(q.totalMinorSAR, { decimals: q.totalMinorSAR % 100 !== 0 })}
                  </td>
                  <td className="px-3 py-2">{when(q.expiresAt, i18n.language)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Note>{t('admin.quotes.none')}</Note>
          )}
          {canManage && (
            <Button className="mt-3" disabled={busy} onClick={() => void createQuote()}>
              {t('admin.quotes.create')}
            </Button>
          )}
        </Section>
      )}

      <Section title={t('admin.leads.messages')}>
        {lead.messages.length === 0 && <Note>{t('admin.leads.noMessages')}</Note>}
        <ul className="mt-2 space-y-2">
          {lead.messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-md border p-3 text-sm ${m.direction === 'inbound' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}
            >
              <p className="font-medium">
                {m.direction === 'inbound'
                  ? t('admin.leads.fromCustomer')
                  : t('admin.leads.fromStaff', { name: m.byName ?? '' })}{' '}
                · {t(`admin.leads.channels.${m.channel}`)} · {when(m.createdAt, i18n.language)}
              </p>
              <p className="mt-1 whitespace-pre-line" dir="auto">
                {m.body}
              </p>
            </li>
          ))}
        </ul>
        {canManage && (
          <form onSubmit={logReply} className="mt-3 space-y-2">
            <Textarea
              id="lead-reply"
              label={t('admin.leads.logReply')}
              value={reply.body}
              onChange={(e) => setReply((r) => ({ ...r, body: e.target.value }))}
            />
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <Select
                  id="lead-reply-channel"
                  label={t('admin.leads.channel')}
                  value={reply.channel}
                  onChange={(e) =>
                    setReply((r) => ({
                      ...r,
                      channel: e.target.value as 'email' | 'whatsapp_manual',
                    }))
                  }
                >
                  <option value="whatsapp_manual">
                    {t('admin.leads.channels.whatsapp_manual')}
                  </option>
                  <option value="email">{t('admin.leads.channels.email')}</option>
                </Select>
              </div>
              <Button type="submit" disabled={busy}>
                {t('admin.leads.saveReply')}
              </Button>
            </div>
          </form>
        )}
      </Section>

      <Section title={t('admin.leads.staffNotes')}>
        <ul className="mt-2 space-y-2">
          {lead.notes.map((n, index) => (
            <li key={index} className="rounded-md border border-slate-200 bg-white p-3 text-sm">
              <p className="font-medium">
                {n.by} · {when(n.at, i18n.language)}
              </p>
              <p className="mt-1 whitespace-pre-line">{n.body}</p>
            </li>
          ))}
        </ul>
        {canManage && (
          <form onSubmit={addNote} className="mt-3 space-y-2">
            <Textarea
              id="lead-note"
              label={t('admin.leads.addNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              {t('admin.leads.saveNote')}
            </Button>
          </form>
        )}
      </Section>
    </div>
  );
}
