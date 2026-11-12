import { useTranslation } from 'react-i18next';
import type { Language } from '../i18n';

const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = [
  { code: 'ru', label: 'RU' },
  { code: 'en', label: 'EN' },
];

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const current: Language = i18n.resolvedLanguage === 'en' ? 'en' : 'ru';

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      className="inline-flex rounded-lg border border-outline bg-surface-container p-0.5"
    >
      {LANGUAGES.map(({ code, label }) => {
        const isActive = current === code;

        return (
          <button
            key={code}
            type="button"
            onClick={() => {
              void i18n.changeLanguage(code);
            }}
            aria-pressed={isActive}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
              isActive
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
