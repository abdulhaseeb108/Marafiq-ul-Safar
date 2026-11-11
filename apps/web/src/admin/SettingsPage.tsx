import type { SettingsView } from '@marafiq/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { Alert, Button, Field, Note, Section, errorText } from './ui';

export function SettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SettingsView>('/admin/settings')
      .then(setSettings)
      .catch((err: unknown) => setError(errorText(err, t)));
  }, [t]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api<SettingsView>('/admin/settings', {
        method: 'PUT',
        body: {
          markupPercent: settings.markupPercent,
          estimateExpiryHours: settings.estimateExpiryHours,
          responseTimeText: settings.responseTimeText,
          childAsAdult: settings.childAsAdult,
          showSupplierRates: settings.showSupplierRates,
        },
      });
      setSettings(updated);
      setSaved(true);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <p>{error ?? t('admin.common.loading')}</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t('admin.settings.title')}</h1>
      {error && <Alert>{error}</Alert>}
      {saved && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm"
        >
          {t('admin.settings.saved')}
        </p>
      )}

      <form onSubmit={save} className="space-y-6" noValidate>
        <Section title={t('admin.settings.pricing')}>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <Field
                id="markup"
                type="number"
                min={0}
                max={100}
                step={0.01}
                dir="ltr"
                label={t('admin.settings.markupPercent')}
                value={String(settings.markupPercent)}
                onChange={(e) =>
                  setSettings({ ...settings, markupPercent: Number(e.target.value) })
                }
              />
              <Note>{t('admin.settings.markupHint')}</Note>
            </div>
            <div>
              <Field
                id="expiry"
                type="number"
                min={1}
                max={720}
                dir="ltr"
                label={t('admin.settings.estimateExpiryHours')}
                value={String(settings.estimateExpiryHours)}
                onChange={(e) =>
                  setSettings({ ...settings, estimateExpiryHours: Number(e.target.value) })
                }
              />
              <Note>{t('admin.settings.expiryHint')}</Note>
            </div>
          </div>
        </Section>

        <Section title={t('admin.settings.customerFacing')}>
          <div className="mt-3 space-y-4">
            <Field
              id="response-time"
              label={t('admin.settings.responseTimeText')}
              value={settings.responseTimeText}
              onChange={(e) => setSettings({ ...settings, responseTimeText: e.target.value })}
            />
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={settings.showSupplierRates}
                onChange={(e) => setSettings({ ...settings, showSupplierRates: e.target.checked })}
                className="mt-1 size-5"
              />
              <span>
                {t('admin.settings.showSupplierRates')}
                <Note>{t('admin.settings.showSupplierRatesHint')}</Note>
              </span>
            </label>
          </div>
        </Section>

        <Section title={t('admin.settings.travelers')}>
          <div className="mt-3 space-y-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={settings.childAsAdult}
                onChange={(e) => setSettings({ ...settings, childAsAdult: e.target.checked })}
                className="mt-1 size-5"
              />
              <span>
                {t('admin.settings.childAsAdult')}
                <Note>{t('admin.settings.childAsAdultHint')}</Note>
              </span>
            </label>
            <p className="text-sm">
              {t('admin.settings.infantHotelCharge')}: {t('admin.settings.infantNone')}
            </p>
          </div>
        </Section>

        <Button type="submit" disabled={busy}>
          {t('admin.common.save')}
        </Button>
      </form>
    </div>
  );
}
