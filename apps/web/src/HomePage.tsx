import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from './components/LanguageSwitch';

export function HomePage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <p className="text-lg font-semibold">{t('app.name')}</p>
          <LanguageSwitch />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold sm:text-3xl">{t('hello.title')}</h1>
        <p className="mt-4">{t('hello.body')}</p>
        <p className="mt-4 text-sm text-slate-700">{t('hello.notice')}</p>
      </main>
    </div>
  );
}
