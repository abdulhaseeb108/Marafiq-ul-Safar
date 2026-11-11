import { ROLES, type Paged, type PublicUser, type Role } from '@marafiq/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { useAuth } from './AuthContext';
import { Alert, Button, Field, errorText, fieldErrors } from './ui';

const EMPTY_FORM = { name: '', email: '', role: 'sales' as Role, password: '' };

export function UsersPage() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await api<Paged<PublicUser>>('/admin/users?limit=100');
      setUsers(page.items);
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== 'authenticated') return null;
  const me = state.user;
  if (me.role !== 'admin') return <Alert>{t('admin.errors.forbidden')}</Alert>;

  /** Run one change, then reload the list from the server. */
  async function act(request: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await request();
      await load();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFormErrors({});
    try {
      await api('/admin/users', { method: 'POST', body: form });
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(errorText(err, t));
      setFormErrors(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  const patch = (id: string, body: object) =>
    act(() => api(`/admin/users/${id}`, { method: 'PATCH', body }));
  const post = (id: string, action: string) =>
    act(() => api(`/admin/users/${id}/${action}`, { method: 'POST' }));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">{t('admin.users.title')}</h1>
      {error && <Alert>{error}</Alert>}

      <section aria-labelledby="new-user">
        <h2 id="new-user" className="text-lg font-semibold">
          {t('admin.users.addTitle')}
        </h2>
        <form onSubmit={createUser} className="mt-3 grid gap-4 sm:grid-cols-2" noValidate>
          <Field
            id="new-name"
            label={t('admin.users.name')}
            required
            value={form.name}
            error={formErrors.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Field
            id="new-email"
            type="email"
            dir="ltr"
            label={t('admin.login.email')}
            autoComplete="off"
            required
            value={form.email}
            error={formErrors.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <div>
            <label htmlFor="new-role" className="block text-sm font-medium">
              {t('admin.users.role')}
            </label>
            <select
              id="new-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
              className="mt-1 block min-h-11 w-full rounded-md border border-slate-400 bg-white px-3 text-base"
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`admin.roles.${role}`)}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="new-password"
            type="password"
            dir="ltr"
            label={t('admin.users.tempPassword')}
            autoComplete="new-password"
            required
            minLength={12}
            value={form.password}
            error={formErrors.password && t('admin.users.passwordRule')}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {t('admin.users.add')}
            </Button>
            {form.role === 'admin' && (
              <p className="mt-2 text-sm text-slate-700">{t('admin.users.adminNeeds2fa')}</p>
            )}
          </div>
        </form>
      </section>

      <section aria-labelledby="all-users">
        <h2 id="all-users" className="text-lg font-semibold">
          {t('admin.users.listTitle')}
        </h2>
        {users === null ? (
          <p className="mt-3">{t('admin.common.loading')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {users.map((user) => {
              const isMe = user.id === me.id;
              return (
                <li key={user.id} className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {user.name}{' '}
                        {isMe && (
                          <span className="text-sm text-slate-700">({t('admin.users.you')})</span>
                        )}
                      </p>
                      <p dir="ltr" className="text-start text-sm text-slate-700">
                        {user.email}
                      </p>
                      <p className="mt-1 text-sm">
                        {t(user.active ? 'admin.users.active' : 'admin.users.inactive')} ·{' '}
                        {t(
                          user.twoFactorEnabled
                            ? 'admin.users.twoFactorOn'
                            : 'admin.users.twoFactorOff',
                        )}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label htmlFor={`role-${user.id}`} className="sr-only">
                        {t('admin.users.roleFor', { name: user.name })}
                      </label>
                      <select
                        id={`role-${user.id}`}
                        value={user.role}
                        disabled={busy || isMe}
                        onChange={(e) => void patch(user.id, { role: e.target.value })}
                        className="min-h-11 rounded-md border border-slate-400 bg-white px-2 text-sm disabled:opacity-60"
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {t(`admin.roles.${role}`)}
                          </option>
                        ))}
                      </select>
                      {user.active ? (
                        <Button
                          variant="secondary"
                          disabled={busy || isMe}
                          onClick={() => void post(user.id, 'deactivate')}
                        >
                          {t('admin.users.deactivate')}
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void patch(user.id, { active: true })}
                        >
                          {t('admin.users.reactivate')}
                        </Button>
                      )}
                      {user.twoFactorEnabled && !isMe && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void post(user.id, 'reset-2fa')}
                        >
                          {t('admin.users.reset2fa')}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
