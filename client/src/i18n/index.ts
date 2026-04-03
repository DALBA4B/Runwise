import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ru from './locales/ru.json';
import en from './locales/en.json';
import uk from './locales/uk.json';

const SUPPORTED_LANGS = ['ru', 'uk', 'en'];

function detectLanguage(): string {
  const saved = localStorage.getItem('runwise_language');
  if (saved) return saved;

  const browserLang = (navigator.language || '').toLowerCase().split('-')[0];
  if (SUPPORTED_LANGS.includes(browserLang)) return browserLang;

  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
    uk: { translation: uk },
  },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export default i18n;
