import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800';

export const buttonPrimary = `inline-flex min-h-11 items-center justify-center rounded-md bg-emerald-800 px-4 font-semibold text-white hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;

export const buttonSecondary = `inline-flex min-h-11 items-center justify-center rounded-md border border-emerald-800 bg-white px-4 font-semibold text-emerald-900 hover:bg-emerald-50 ${focusRing}`;

export function PageTitle({ title, intro }: { title: string; intro?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
      {intro && <p className="mt-3 max-w-prose text-slate-700">{intro}</p>}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      {title && <h2 className="mb-3 text-lg font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

/** Until the online inquiry form ships (Phase 6), quotes are requested via Contact. */
export function RequestQuoteLink({ topic }: { topic: string }) {
  const { t } = useTranslation();
  return (
    <Link to={`/contact?topic=${encodeURIComponent(topic)}`} className={buttonPrimary}>
      {t('site.requestQuote')}
    </Link>
  );
}

/** Text the client or a lawyer must supply before launch. Visible on purpose. */
export function ReviewMarker({ label }: { label: string }) {
  return (
    <span
      lang="en"
      dir="ltr"
      className="rounded bg-amber-100 px-1.5 py-0.5 text-sm font-semibold text-amber-900"
    >
      {label}
    </span>
  );
}
