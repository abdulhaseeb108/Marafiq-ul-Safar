import { LANGUAGES } from '@marafiq/shared';
import { useTranslation } from 'react-i18next';
import { LANGUAGE_NAMES, directionOf } from '../i18n';

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();

  return (
    <div role="group" aria-label={t('language.label')} className="flex gap-1">
      {LANGUAGES.map((language) => {
        const active = i18n.resolvedLanguage === language;
        return (
          <button
            key={language}
            type="button"
            lang={language}
            dir={directionOf(language)}
            aria-pressed={active}
            onClick={() => void i18n.changeLanguage(language)}
            className={`min-h-11 min-w-11 rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 ${
              active
                ? 'border-emerald-800 bg-emerald-800 text-white'
                : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100'
            }`}
          >
            {LANGUAGE_NAMES[language]}
          </button>
        );
      })}
    </div>
  );
}
