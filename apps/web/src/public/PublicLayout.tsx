import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { CurrencyProvider, useCurrency } from './CurrencyContext';
import type { Currency } from './format';

export const NAV = [
  { to: '/', key: 'home', end: true },
  { to: '/umrah', key: 'umrah' },
  { to: '/hotels', key: 'hotels' },
  { to: '/flights', key: 'flights' },
  { to: '/visa', key: 'visa' },
  { to: '/transport', key: 'transport' },
  { to: '/faq', key: 'faq' },
  { to: '/contact', key: 'contact' },
] as const;

const focus =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800';

function CurrencySwitch() {
  const { t } = useTranslation();
  const { primary, setPrimary } = useCurrency();
  return (
    <div role="group" aria-label={t('site.currency')} className="flex gap-1">
      {(['PKR', 'SAR'] as Currency[]).map((currency) => (
        <button
          key={currency}
          type="button"
          lang="en"
          aria-pressed={primary === currency}
          onClick={() => setPrimary(currency)}
          className={`min-h-11 min-w-11 rounded-md border px-2 text-sm ${focus} ${
            primary === currency
              ? 'border-emerald-800 bg-emerald-800 text-white'
              : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100'
          }`}
        >
          {currency}
        </button>
      ))}
    </div>
  );
}

function Header() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { pathname } = useLocation();

  // Close the phone menu after moving to another page.
  useEffect(() => setOpen(false), [pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-2 ${focus} ${
      isActive
        ? 'bg-emerald-50 font-semibold text-emerald-900'
        : 'text-slate-800 hover:bg-slate-100'
    }`;

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2">
        <Link
          to="/"
          className={`me-auto rounded-md py-2 text-lg font-bold text-emerald-900 ${focus}`}
        >
          {t('app.name')}
        </Link>
        <LanguageSwitch />
        <CurrencySwitch />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
          className={`min-h-11 rounded-md border border-slate-400 px-3 text-sm lg:hidden ${focus}`}
        >
          {t('site.menu')}
        </button>
      </div>
      <nav aria-label={t('site.mainNav')} className="mx-auto max-w-5xl px-4">
        <ul
          id={menuId}
          className={`${open ? 'flex' : 'hidden'} flex-col gap-1 pb-3 lg:flex lg:flex-row lg:flex-wrap lg:pb-2`}
        >
          {NAV.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={'end' in item} className={linkClass}>
                {t(`site.nav.${item.key}`)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

function Footer() {
  const { t, i18n } = useTranslation();
  // Non-empty only in languages still waiting for an approved translation. Read the
  // raw value: t() treats "" as missing and would print the key itself.
  const pendingValue: unknown = i18n.getResource(
    i18n.resolvedLanguage ?? i18n.language,
    'translation',
    'site.legal.translationPending',
  );
  const translationPending = typeof pendingValue === 'string' ? pendingValue : '';
  const link = `rounded-sm underline ${focus}`;
  return (
    <footer className="mt-12 border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-5xl space-y-3 px-4 py-6 text-sm text-slate-700">
        <p>{t('site.ratesNotice')}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          <li>
            <Link className={link} to="/policies/privacy">
              {t('site.policies.privacy')}
            </Link>
          </li>
          <li>
            <Link className={link} to="/policies/terms">
              {t('site.policies.terms')}
            </Link>
          </li>
          <li>
            <Link className={link} to="/policies/quote-terms">
              {t('site.policies.quoteTerms')}
            </Link>
          </li>
          <li>
            <Link className={link} to="/contact">
              {t('site.nav.contact')}
            </Link>
          </li>
        </ul>
        {/* docs/05 #1 and #2: display name and licence status from the owner; bracketed
            parts are placeholders, never invented. English until an approved Urdu
            translation exists (never machine-translated). Each line is its own isolate
            so English stays in order inside the RTL footer. */}
        <p>
          <bdi lang="en">
            {t('site.legal.company')} — {t('site.legal.service')}
          </bdi>
          <span className="block">
            <bdi lang="en">
              {t('site.legal.licenceStatus')} — {t('site.legal.licenceDetails')}
            </bdi>
          </span>
          <span className="block">
            <bdi lang="en">{t('site.legal.fulfilment')}</bdi>
          </span>
          {translationPending && (
            // Own line and own isolate: English inside an RTL footer would otherwise
            // mirror the brackets and split around the sentence above.
            <span className="block font-semibold">
              <bdi lang="en">{translationPending}</bdi>
            </span>
          )}
        </p>
        <p>© {t('app.name')}</p>
      </div>
    </footer>
  );
}

/** Header, footer and the PKR/SAR choice for every public page. */
export function PublicLayout() {
  const { t } = useTranslation();
  return (
    <CurrencyProvider>
      <div className="flex min-h-screen flex-col overflow-x-clip bg-slate-50 text-slate-900">
        <a
          href="#main"
          className="sr-only rounded-md bg-white px-3 py-2 focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-10 focus:outline-2 focus:outline-emerald-800"
        >
          {t('site.skip')}
        </a>
        <Header />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">
          <Outlet />
        </main>
        <Footer />
      </div>
    </CurrencyProvider>
  );
}
