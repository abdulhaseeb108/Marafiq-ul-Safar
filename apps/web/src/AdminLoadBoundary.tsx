import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The staff screens are a separate download (App.tsx). If that download fails
 * (dropped connection, or a new release replaced the file while a staff tab was
 * open) React cannot recover on its own: `lazy()` keeps the failed import. So we
 * say what happened and offer a full page reload. Lives outside src/admin so it
 * ships with the main bundle and works when the admin download does not.
 */

/** The errors browsers raise when a code-split file cannot be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    message,
  );
}

function LoadFailed() {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mx-auto max-w-md p-4">
      <h1 className="text-lg font-semibold text-slate-900">{t('admin.loadFailed.title')}</h1>
      <p className="mt-2 text-sm text-slate-700">{t('admin.loadFailed.body')}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 min-h-11 rounded-md border border-emerald-800 bg-emerald-800 px-4 text-sm font-medium text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
      >
        {t('admin.loadFailed.reload')}
      </button>
    </div>
  );
}

export class AdminLoadBoundary extends Component<
  { children: ReactNode },
  { failed: Error | null }
> {
  override state: { failed: Error | null } = { failed: null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { failed } = this.state;
    if (!failed) return this.props.children;
    // Only download failures are handled here; anything else behaves as before.
    if (!isChunkLoadError(failed)) throw failed;
    return <LoadFailed />;
  }
}
