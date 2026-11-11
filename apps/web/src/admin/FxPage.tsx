import { FX_LARGE_CHANGE_PERCENT, type FxRateView } from '@marafiq/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiRequestError } from './api';
import { useResource } from './useResource';
import { Alert, Button, Field, Note, Section, Table } from './ui';

export function FxPage() {
  const { t, i18n } = useTranslation();
  const { items, error, formErrors, busy, run, setError } = useResource<FxRateView>('/admin/fx');
  const [rate, setRate] = useState('');
  /** Set when the API asked for confirmation of a large change. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const current = items?.[0] ?? null;
  const dates = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  async function submit(event: FormEvent, confirmLargeChange = false) {
    event.preventDefault();
    setConfirming(null);
    const ok = await run(async () => {
      try {
        return await api('/admin/fx', { method: 'POST', body: { rate, confirmLargeChange } });
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'large_fx_change') {
          setConfirming(rate);
        }
        throw err;
      }
    });
    if (ok) setRate('');
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.fx.title')}</h1>
      {error && !confirming && <Alert>{error}</Alert>}

      <Section title={t('admin.fx.addTitle')}>
        <p className="mt-2 text-sm">
          {current
            ? t('admin.fx.current', {
                rate: current.rate,
                date: dates.format(new Date(current.effectiveAt)),
              })
            : t('admin.fx.noneYet')}
        </p>
        <form onSubmit={(e) => void submit(e)} className="mt-3 max-w-xs space-y-3" noValidate>
          <Field
            id="fx-rate"
            dir="ltr"
            inputMode="decimal"
            label={t('admin.fx.rate')}
            placeholder="75.00"
            required
            value={rate}
            error={formErrors.rate && t('admin.fx.rateRule')}
            onChange={(e) => setRate(e.target.value)}
          />
          <Button type="submit" disabled={busy || rate === ''}>
            {t('admin.fx.add')}
          </Button>
          <Note>{t('admin.fx.appendOnly')}</Note>
        </form>

        {confirming && current && (
          <div
            role="alert"
            className="mt-4 max-w-md rounded-md border border-amber-400 bg-amber-50 p-4"
          >
            <p className="font-medium">{t('admin.fx.confirmTitle')}</p>
            <p className="mt-1 text-sm">
              {t('admin.fx.confirmBody', {
                rate: confirming,
                previous: current.rate,
                percent: FX_LARGE_CHANGE_PERCENT,
              })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={busy} onClick={(e) => void submit(e, true)}>
                {t('admin.fx.confirmSave')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirming(null);
                  setError(null);
                }}
              >
                {t('admin.common.cancel')}
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section title={t('admin.fx.historyTitle')}>
        {items === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : (
          <Table headers={[t('admin.fx.rate'), t('admin.fx.effectiveAt'), t('admin.fx.setBy')]}>
            {items.map((row, index) => (
              <tr key={row.id} className="border-b border-slate-200">
                <td dir="ltr" className="px-3 py-2 text-start font-medium">
                  {row.rate}
                  {index === 0 && (
                    <span className="ms-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-normal">
                      {t('admin.fx.latest')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{dates.format(new Date(row.effectiveAt))}</td>
                <td className="px-3 py-2">{row.setByName ?? t('admin.fx.setBySystem')}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
