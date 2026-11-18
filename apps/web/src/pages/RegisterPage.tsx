import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Brand } from '../components/Brand';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { registerRequestSchema } from '../lib/registration';
import { useAuthStore } from '../store/auth.store';

type RegisterField = 'email' | 'password' | 'inviteCode';

const INPUT_CLASSES =
  'block w-full rounded-xl border border-outline bg-surface px-4 py-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const FIELD_ERROR_KEYS: Record<RegisterField, string> = {
  email: 'register.errors.email',
  password: 'register.errors.password',
  inviteCode: 'register.errors.inviteCode',
};

function isRegisterField(value: unknown): value is RegisterField {
  return value === 'email' || value === 'password' || value === 'inviteCode';
}

/** Первая ошибка Zod на поле → ключ i18n; форма показывает её под полем. */
function collectFieldErrorKeys(
  error: z.ZodError,
): Partial<Record<RegisterField, string>> {
  const keys: Partial<Record<RegisterField, string>> = {};

  for (const issue of error.issues) {
    const field = issue.path[0];

    if (isRegisterField(field) && keys[field] === undefined) {
      keys[field] = FIELD_ERROR_KEYS[field];
    }
  }

  return keys;
}

export function RegisterPage() {
  const { t } = useTranslation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const register = useAuthStore((state) => state.register);
  const isSubmitting = useAuthStore((state) => state.isSubmitting);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<RegisterField, string>>
  >({});

  if (accessToken !== null) {
    return <Navigate to="/app/chat" replace />;
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    clearError();
    setFieldErrors({});

    const parsed = registerRequestSchema.safeParse({
      email,
      password,
      inviteCode,
    });

    if (!parsed.success) {
      setFieldErrors(collectFieldErrorKeys(parsed.error));

      return;
    }

    // `inviteCode` попадает в тело запроса только непустым (см. схему).
    try {
      await register(parsed.data);
      navigate('/login', { replace: true });
    } catch {
      // Текст ошибки уже сохранён в auth.store и отображается в alert.
    }
  }

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden bg-surface px-5 py-10 text-on-surface sm:px-8">
      <div
        aria-hidden="true"
        className="login-grid pointer-events-none absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-80 w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 size-80 translate-x-1/3 translate-y-1/3 rounded-full bg-tertiary/10 blur-3xl"
      />

      <div className="fixed right-4 top-4 z-20 flex items-center gap-2">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>

      <main className="relative w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Link
            to="/"
            aria-label="SkillWharf"
            className="w-fit rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Brand />
          </Link>
        </div>

        <div className="rounded-2xl border border-outline-variant bg-surface-container p-6 shadow-xl shadow-primary/5 sm:p-8">
          <h1 className="font-display text-2xl font-bold tracking-tight text-on-surface">
            {t('register.title')}
          </h1>
          <p className="mt-2 text-sm text-on-surface-variant">
            {t('register.subtitle')}
          </p>

          <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
            {error !== null && (
              <div
                role="alert"
                className="rounded-xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container"
              >
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label
                htmlFor="register-email"
                className="block text-sm font-medium text-on-surface"
              >
                {t('register.emailLabel')}
              </label>
              <input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t('register.emailPlaceholder')}
                required
                disabled={isSubmitting}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={fieldErrors.email !== undefined}
                aria-describedby={
                  fieldErrors.email === undefined
                    ? undefined
                    : 'register-email-error'
                }
                className={INPUT_CLASSES}
              />
              {fieldErrors.email !== undefined && (
                <p
                  id="register-email-error"
                  role="alert"
                  className="text-sm text-error"
                >
                  {t(fieldErrors.email)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="register-password"
                className="block text-sm font-medium text-on-surface"
              >
                {t('register.passwordLabel')}
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  name="password"
                  type={isPasswordVisible ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder={t('register.passwordPlaceholder')}
                  required
                  minLength={8}
                  disabled={isSubmitting}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={fieldErrors.password !== undefined}
                  aria-describedby="register-password-hint"
                  className={`${INPUT_CLASSES} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setIsPasswordVisible((visible) => !visible)}
                  aria-label={
                    isPasswordVisible
                      ? t('register.hidePassword')
                      : t('register.showPassword')
                  }
                  aria-pressed={isPasswordVisible}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-on-surface-variant transition hover:text-on-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                >
                  {isPasswordVisible ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-5"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 9 7a11.7 11.7 0 0 1-2.2 3.2" />
                      <path d="M6.6 6.6C4.4 8.1 3 10.4 3 12c0 2.5 4 7 9 7 1.6 0 3-.4 4.2-1.2" />
                      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                    </svg>
                  ) : (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="size-5"
                    >
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
              <p
                id="register-password-hint"
                className="text-xs leading-relaxed text-on-surface-variant"
              >
                {t('register.passwordHint')}
              </p>
              {fieldErrors.password !== undefined && (
                <p role="alert" className="text-sm text-error">
                  {t(fieldErrors.password)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label
                htmlFor="register-invite-code"
                className="block text-sm font-medium text-on-surface"
              >
                {t('register.inviteCodeLabel')}
              </label>
              <input
                id="register-invite-code"
                name="inviteCode"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('register.inviteCodePlaceholder')}
                disabled={isSubmitting}
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                aria-invalid={fieldErrors.inviteCode !== undefined}
                aria-describedby="register-invite-code-hint"
                className={INPUT_CLASSES}
              />
              <p
                id="register-invite-code-hint"
                className="text-xs leading-relaxed text-on-surface-variant"
              >
                {t('register.inviteCodeHint')}
              </p>
              {fieldErrors.inviteCode !== undefined && (
                <p role="alert" className="text-sm text-error">
                  {t(fieldErrors.inviteCode)}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? t('register.submitting') : t('register.submit')}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-on-surface-variant">
          {t('register.haveAccount')}{' '}
          <Link
            to="/login"
            className="font-semibold text-primary underline-offset-4 transition hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('register.loginLink')}
          </Link>
        </p>
      </main>
    </div>
  );
}
