import { useTranslation } from 'react-i18next';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { useAuth } from './AuthContext';
import { menuFor } from './menu';
import { Button } from './ui';

/** Logged-in frame: header, role-aware menu, page content. */
export function AdminShell() {
  const { t } = useTranslation();
  const { state, logout } = useAuth();

  if (state.status === 'loading') {
    return <p className="p-6 text-slate-900">{t('admin.common.loading')}</p>;
  }
  if (state.status === 'anonymous') return <Navigate to="/admin/login" replace />;

  const { user } = state;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-lg font-semibold">
            {t('app.name')} · {t('admin.shell.title')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <LanguageSwitch />
            <Button variant="secondary" onClick={() => void logout()}>
              {t('admin.shell.logout')}
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-5xl px-4 pb-3">
          <p className="text-sm text-slate-700">
            {user.name} · {t(`admin.roles.${user.role}`)}
          </p>
          <nav aria-label={t('admin.shell.menu')} className="mt-2 flex flex-wrap gap-2">
            {menuFor(user.role).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/admin'}
                className={({ isActive }) =>
                  `inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 ${
                    isActive ? 'bg-emerald-800 text-white' : 'bg-slate-100 hover:bg-slate-200'
                  }`
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { state } = useAuth();
  if (state.status !== 'authenticated') return null;
  return (
    <>
      <h1 className="text-2xl font-bold">
        {t('admin.dashboard.title', { name: state.user.name })}
      </h1>
      <p className="mt-3">{t('admin.dashboard.body')}</p>
    </>
  );
}
