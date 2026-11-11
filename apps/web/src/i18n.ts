import { LANGUAGES, type Language } from '@marafiq/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ur from './locales/ur.json';

const STORAGE_KEY = 'msf.lang';

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ur: 'اردو' };

export function directionOf(language: string): 'rtl' | 'ltr' {
  return language === 'ur' ? 'rtl' : 'ltr';
}

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

function storedLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : 'en';
  } catch {
    return 'en'; // storage can be blocked; fall back quietly
  }
}

/** Keep <html lang dir> in step with the active language. */
function applyDocumentLanguage(language: string): void {
  document.documentElement.lang = language;
  document.documentElement.dir = directionOf(language);
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ur: { translation: ur } },
  lng: storedLanguage(),
  fallbackLng: 'en',
  supportedLngs: [...LANGUAGES],
  interpolation: { escapeValue: false }, // React already escapes
});

applyDocumentLanguage(i18n.language);

i18n.on('languageChanged', (language) => {
  applyDocumentLanguage(language);
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // ignore: preference just will not persist
  }
});

export default i18n;
