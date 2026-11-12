import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';

export type Language = 'ru' | 'en';

const LANGUAGE_STORAGE_KEY = 'skillwharf-language';

function normalizeLanguage(language: string | undefined): Language {
  return language?.startsWith('en') === true ? 'en' : 'ru';
}

/** Язык интерфейса: сохранённый выбор пользователя, иначе русский. */
export function getStoredLanguage(): Language {
  try {
    return normalizeLanguage(
      window.localStorage.getItem(LANGUAGE_STORAGE_KEY) ?? undefined,
    );
  } catch {
    return 'ru';
  }
}

function applyDocumentLanguage(language: Language): void {
  document.documentElement.lang = language;
  document.title = i18n.t('meta.title');

  const description = document.querySelector('meta[name="description"]');
  description?.setAttribute('content', i18n.t('meta.description'));
}

const initialLanguage = getStoredLanguage();

// Язык документа нужен скринридерам ещё до завершения инициализации i18next.
document.documentElement.lang = initialLanguage;

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      ru: { translation: ru },
      en: { translation: en },
    },
    lng: initialLanguage,
    fallbackLng: 'ru',
    supportedLngs: ['ru', 'en'],
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  .then(() => {
    applyDocumentLanguage(initialLanguage);
  });

i18n.on('languageChanged', (language) => {
  const normalized = normalizeLanguage(language);

  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // В приватном режиме выбор не сохранится, но язык переключится.
  }

  applyDocumentLanguage(normalized);
});

export default i18n;
