import {
  formatMinor,
  parseMajorToMinor,
  type QuoteDetail,
  type SendQuoteResponse,
  type UpdateQuoteBody,
} from '@marafiq/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiRequestError, api } from './api';
import { useAuth } from './AuthContext';
import {
  Alert,
  Button,
  Field,
  Note,
  Section,
  Select,
  Table,
  Textarea,
  errorText,
  fieldErrors,
} from './ui';

interface LineForm {
  key: number;
  description: string;
  supplier: string;
  quantity: string;
  /** Major units as typed, e.g. "1,800.50". */
  unit: string;
  currency: 'SAR' | 'PKR';
  notes: string;
}

const money = (currency: string, minor: number) =>
  `${currency} ${formatMinor(minor, { decimals: minor % 100 !== 0 })}`;
const majorText = (minor: number) => (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);

function toForm(quote: QuoteDetail, startKey: number): LineForm[] {
  return quote.lineItems.map((line, index) => ({
    key: startKey + index,
    description: line.description,
    supplier: line.supplier,
    quantity: String(line.quantity),
    unit: majorText(line.unitAmountMinor),
    currency: line.currency,
    notes: line.notes,
  }));
}

/** Pakistan date of a stored expiry instant (23:59 Pakistan time on that day). */
const expiryDate = (at: string) =>
  new Date(new Date(at).getTime() + 5 * 3_600_000).toISOString().slice(0, 10);

/** Quote builder (docs/01 section 6.7): edit a draft, send it, version it. */
export function QuoteBuilderPage() {
  const { t, i18n } = useTranslation();
  const { quoteId = '' } = useParams();
  const navigate = useNavigate();
  const { state } = useAuth();
  const canManage =
    state.status === 'authenticated' && ['admin', 'sales'].includes(state.user.role);

  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [lines, setLines] = useState<LineForm[]>([]);
  const [exclusions, setExclusions] = useState('');
  const [terms, setTerms] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [dirty, setDirty] = useState(false);
  const [nextKey, setNextKey] = useState(1000);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ url: string; emailed: boolean | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const show = useCallback((next: QuoteDetail) => {
    setQuote(next);
    setLines(toForm(next, 0));
    setExclusions(next.exclusions.join('\n'));
    setTerms(next.terms);
    setExpiresOn(expiryDate(next.expiresAt));
    setDirty(false);
  }, []);

  useEffect(() => {
    setLink(null);
    api<QuoteDetail>(`/admin/quotes/${quoteId}`).then(show, (err: unknown) =>
      setError(errorText(err, t)),
    );
  }, [quoteId, show, t]);

  const edit = <K extends keyof LineForm>(index: number, key: K, value: LineForm[K]) => {
    setLines((all) => all.map((line, i) => (i === index ? { ...line, [key]: value } : line)));
    setDirty(true);
  };

  function body(): UpdateQuoteBody | null {
    const lineItems = [];
    for (const [index, line] of lines.entries()) {
      let unitAmountMinor: number;
      try {
        unitAmountMinor = parseMajorToMinor(line.unit.replace(/,/g, '').trim());
      } catch {
        setFields({ [`lineItems.${index}.unitAmountMinor`]: t('admin.quotes.amountRule') });
        setError(t('admin.quotes.lineProblem', { n: index + 1 }));
        return null;
      }
      lineItems.push({
        description: line.description,
        supplier: line.supplier,
        quantity: Number(line.quantity),
        unitAmountMinor,
        currency: line.currency,
        notes: line.notes,
      });
    }
    return {
      lineItems,
      exclusions: exclusions
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      terms,
      expiresOn,
    };
  }

  async function run<T>(request: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      return await request();
    } catch (err) {
      setError(errorText(err, t));
      setFields(fieldErrors(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const payload = body();
    if (!payload) return;
    const next = await run(() =>
      api<QuoteDetail>(`/admin/quotes/${quoteId}`, { method: 'PUT', body: payload }),
    );
    if (next) show(next);
  }

  async function send() {
    const result = await run(() =>
      api<SendQuoteResponse>(`/admin/quotes/${quoteId}/send`, { method: 'POST' }),
    );
    if (result) {
      show(result.quote);
      setLink({ url: result.link, emailed: result.emailed });
    }
  }

  async function newVersion() {
    setBusy(true);
    setError(null);
    try {
      const draft = await api<QuoteDetail>(`/admin/quotes/${quoteId}/new-version`, {
        method: 'POST',
      });
      void navigate(`/admin/quotes/${draft.id}`);
    } catch (err) {
      const existing = err instanceof ApiRequestError ? err.fields?.existingId : undefined;
      if (existing) void navigate(`/admin/quotes/${existing}`);
      else setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function renewLink() {
    const result = await run(() =>
      api<{ link: string }>(`/admin/quotes/${quoteId}/link`, { method: 'POST' }),
    );
    if (result) setLink({ url: result.link, emailed: null });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!quote) return error ? <Alert>{error}</Alert> : <p>{t('admin.common.loading')}</p>;
  const editable = canManage && quote.status === 'draft';
  const date = (at: string) =>
    new Intl.DateTimeFormat(i18n.language === 'ur' ? 'ur-PK' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Karachi',
      numberingSystem: 'latn',
    }).format(new Date(at));

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm">
          <Link to={`/admin/leads/${quote.leadId}`} className="underline">
            {t('admin.quotes.backToLead', { reference: quote.reference })}
          </Link>
        </p>
        <h1 className="mt-2 text-2xl font-bold">
          {t('admin.quotes.heading', { reference: quote.reference, n: quote.version })} ·{' '}
          {t(`admin.quotes.statuses.${quote.status}`)}
        </h1>
        <p className="text-sm text-slate-700">
          {quote.sentAt && `${t('admin.quotes.sentAt', { at: date(quote.sentAt) })} · `}
          {t('admin.quotes.expiresAt', { at: date(quote.expiresAt) })}
          {quote.fx && ` · 1 SAR = PKR ${quote.fx.rate}`}
        </p>
      </div>
      {error && <Alert>{error}</Alert>}

      {link && (
        <div
          role="status"
          className="space-y-2 rounded-md border-2 border-emerald-700 bg-emerald-50 p-4"
        >
          <p className="font-semibold">{t('admin.quotes.linkReady')}</p>
          <label htmlFor="quote-link" className="block text-sm">
            {t('admin.quotes.linkLabel')}
          </label>
          <input
            id="quote-link"
            readOnly
            value={link.url}
            onFocus={(e) => e.target.select()}
            className="block min-h-11 w-full rounded-md border border-slate-400 bg-white px-3 text-sm"
            dir="ltr"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void copy()}>
              {copied ? t('admin.quotes.copied') : t('admin.quotes.copy')}
            </Button>
            {link.emailed !== null && (
              <span className="text-sm">
                {link.emailed ? t('admin.quotes.emailed') : t('admin.quotes.notEmailed')}
              </span>
            )}
          </div>
          <Note>{t('admin.quotes.linkOnce')}</Note>
        </div>
      )}

      {quote.missingFromCalculation.length > 0 && (
        <Section title={t('admin.quotes.stillToPrice')}>
          <ul className="mt-2 list-disc ps-5 text-sm">
            {quote.missingFromCalculation.map((m, index) => (
              <li key={index}>{m}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('admin.quotes.lines')}>
        {editable ? (
          <ol className="mt-3 space-y-4">
            {lines.map((line, index) => (
              <li key={line.key} className="rounded-md border border-slate-300 bg-white p-3">
                <p className="mb-2 font-medium">{t('admin.quotes.lineN', { n: index + 1 })}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    id={`ql-${index}-description`}
                    label={t('admin.quotes.description')}
                    value={line.description}
                    error={fields[`lineItems.${index}.description`]}
                    onChange={(e) => edit(index, 'description', e.target.value)}
                  />
                  <Field
                    id={`ql-${index}-supplier`}
                    label={t('admin.quotes.supplier')}
                    value={line.supplier}
                    error={fields[`lineItems.${index}.supplier`]}
                    onChange={(e) => edit(index, 'supplier', e.target.value)}
                  />
                  <Field
                    id={`ql-${index}-quantity`}
                    label={t('admin.quotes.quantity')}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={line.quantity}
                    error={fields[`lineItems.${index}.quantity`]}
                    onChange={(e) => edit(index, 'quantity', e.target.value)}
                  />
                  <div className="grid grid-cols-[1fr_7rem] gap-2">
                    <Field
                      id={`ql-${index}-unit`}
                      label={t('admin.quotes.unit')}
                      inputMode="decimal"
                      value={line.unit}
                      error={fields[`lineItems.${index}.unitAmountMinor`]}
                      onChange={(e) => edit(index, 'unit', e.target.value)}
                    />
                    <Select
                      id={`ql-${index}-currency`}
                      label={t('admin.quotes.currency')}
                      value={line.currency}
                      onChange={(e) => edit(index, 'currency', e.target.value as 'SAR' | 'PKR')}
                    >
                      <option value="SAR">SAR</option>
                      <option value="PKR">PKR</option>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Field
                      id={`ql-${index}-notes`}
                      label={t('admin.quotes.lineNotes')}
                      value={line.notes}
                      onChange={(e) => edit(index, 'notes', e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  variant="secondary"
                  className="mt-3"
                  aria-label={t('admin.quotes.removeLineN', { n: index + 1 })}
                  onClick={() => {
                    setLines((all) => all.filter((_, i) => i !== index));
                    setDirty(true);
                  }}
                >
                  {t('admin.quotes.removeLine')}
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <Table
            headers={[
              t('admin.quotes.description'),
              t('admin.quotes.supplier'),
              t('admin.quotes.quantity'),
              t('admin.quotes.unit'),
              t('admin.quotes.amount'),
            ]}
          >
            {quote.lineItems.map((line, index) => (
              <tr key={index} className="border-b border-slate-200">
                <td className="px-3 py-2">{line.description}</td>
                <td className="px-3 py-2">{line.supplier}</td>
                <td className="px-3 py-2">{line.quantity}</td>
                <td className="px-3 py-2" dir="ltr">
                  {money(line.currency, line.unitAmountMinor)}
                </td>
                <td className="px-3 py-2" dir="ltr">
                  {money(line.currency, line.amountMinor)}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {editable && (
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setLines((all) => [
                ...all,
                {
                  key: nextKey,
                  description: '',
                  supplier: '',
                  quantity: '1',
                  unit: '',
                  currency: 'SAR',
                  notes: '',
                },
              ]);
              setNextKey((k) => k + 1);
              setDirty(true);
            }}
          >
            {t('admin.quotes.addLine')}
          </Button>
        )}
        <p className="mt-4 text-lg font-semibold" dir="ltr">
          {money('PKR', quote.totals.totalMinorPKR)} · {money('SAR', quote.totals.totalMinorSAR)}
        </p>
        {dirty && <Note>{t('admin.quotes.unsaved')}</Note>}
      </Section>

      <Section title={t('admin.quotes.exclusionsAndTerms')}>
        <div className="mt-3 space-y-3">
          <Textarea
            id="q-exclusions"
            label={t('admin.quotes.exclusions')}
            rows={4}
            disabled={!editable}
            value={exclusions}
            onChange={(e) => {
              setExclusions(e.target.value);
              setDirty(true);
            }}
          />
          <Textarea
            id="q-terms"
            label={t('admin.quotes.terms')}
            rows={5}
            disabled={!editable}
            value={terms}
            onChange={(e) => {
              setTerms(e.target.value);
              setDirty(true);
            }}
          />
          <div className="max-w-xs">
            <Field
              id="q-expires"
              label={t('admin.quotes.expiresOn')}
              type="date"
              disabled={!editable}
              value={expiresOn}
              error={fields.expiresOn}
              onChange={(e) => {
                setExpiresOn(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        </div>
      </Section>

      {canManage && (
        <div className="flex flex-wrap gap-3">
          {editable && (
            <>
              <Button disabled={busy} onClick={() => void save()}>
                {t('admin.quotes.save')}
              </Button>
              <Button disabled={busy || dirty} onClick={() => void send()}>
                {t('admin.quotes.send')}
              </Button>
            </>
          )}
          {quote.status === 'sent' && (
            <>
              <Button disabled={busy} onClick={() => void newVersion()}>
                {t('admin.quotes.newVersion')}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void renewLink()}>
                {t('admin.quotes.renewLink')}
              </Button>
            </>
          )}
        </div>
      )}
      {editable && dirty && <Note>{t('admin.quotes.saveBeforeSend')}</Note>}

      <Section title={t('admin.quotes.history')}>
        <ul className="mt-2 space-y-1 text-sm">
          {quote.history.map((h) => (
            <li key={h.id}>
              {h.id === quote.id ? (
                <span className="font-semibold">
                  {t('admin.quotes.versionN', { n: h.version })} ·{' '}
                  {t(`admin.quotes.statuses.${h.status}`)}
                </span>
              ) : (
                <Link to={`/admin/quotes/${h.id}`} className="underline">
                  {t('admin.quotes.versionN', { n: h.version })} ·{' '}
                  {t(`admin.quotes.statuses.${h.status}`)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
