import type { SupplierType, SupplierView } from '@marafiq/shared';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useResource } from './useResource';
import { Alert, Button, Field, Section, Select, Table, Textarea } from './ui';

const TYPES: SupplierType[] = ['hotel_operator', 'transport', 'flight_partner', 'other'];
const EMPTY = {
  name: '',
  type: 'hotel_operator' as SupplierType,
  contactName: '',
  phone: '',
  email: '',
  notes: '',
};

export function SuppliersPage() {
  const { t } = useTranslation();
  const { items, error, formErrors, busy, run } = useResource<SupplierView>('/admin/suppliers');
  const [form, setForm] = useState(EMPTY);

  async function add(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => api('/admin/suppliers', { method: 'POST', body: form }));
    if (ok) setForm(EMPTY);
  }

  const setActive = (id: string, active: boolean) =>
    run(() =>
      active
        ? api(`/admin/suppliers/${id}`, { method: 'PATCH', body: { active: true } })
        : api(`/admin/suppliers/${id}/deactivate`, { method: 'POST' }),
    );

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.suppliers.title')}</h1>
      {error && <Alert>{error}</Alert>}

      <Section title={t('admin.suppliers.addTitle')}>
        <form onSubmit={add} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
          <Field
            id="s-name"
            label={t('admin.suppliers.name')}
            required
            value={form.name}
            error={formErrors.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Select
            id="s-type"
            label={t('admin.suppliers.type')}
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as SupplierType })}
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`admin.suppliers.types.${type}`)}
              </option>
            ))}
          </Select>
          <Field
            id="s-contact"
            label={t('admin.suppliers.contactName')}
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
          <Field
            id="s-phone"
            dir="ltr"
            label={t('admin.suppliers.phone')}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <Field
            id="s-email"
            type="email"
            dir="ltr"
            label={t('admin.suppliers.email')}
            value={form.email}
            error={formErrors.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Textarea
            id="s-notes"
            label={t('admin.suppliers.notes')}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('admin.suppliers.add')}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t('admin.suppliers.listTitle')}>
        {items === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : (
          <Table
            headers={[
              t('admin.suppliers.name'),
              t('admin.suppliers.type'),
              t('admin.suppliers.contact'),
              t('admin.common.status'),
              t('admin.common.actions'),
            ]}
          >
            {items.map((supplier) => (
              <tr key={supplier.id} className="border-b border-slate-200">
                <td className="px-3 py-2">{supplier.name}</td>
                <td className="px-3 py-2">{t(`admin.suppliers.types.${supplier.type}`)}</td>
                <td className="px-3 py-2">
                  {supplier.contactName ?? '—'}
                  {supplier.phone && (
                    <span dir="ltr" className="block text-slate-700">
                      {supplier.phone}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {t(supplier.active ? 'admin.common.active' : 'admin.common.inactive')}
                </td>
                <td className="px-3 py-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void setActive(supplier.id, !supplier.active)}
                  >
                    {t(supplier.active ? 'admin.common.deactivate' : 'admin.common.reactivate')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
