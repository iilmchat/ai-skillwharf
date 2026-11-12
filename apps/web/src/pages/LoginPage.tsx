import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuthStore } from '../store/auth.store';

interface LoginLocationState {
  from?: string;
}

const FEATURES = [
  'Автономные агенты с доступом к инструментам',
  'Изолированная песочница для выполнения кода',
  'Единое пространство для чатов и задач',
];

const CURRENT_YEAR = new Date().getFullYear();

const INPUT_CLASSES =
  'block w-full rounded-xl border border-outline bg-surface px-4 py-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

export function LoginPage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const login = useAuthStore((state) => state.login);
  const isSubmitting = useAuthStore((state) => state.isSubmitting);
  const error = useAuthStore((state) => state.error);
  const clearError = useAuthStore((state) => state.clearError);

  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  if (accessToken !== null) {
    return <Navigate to="/chat" replace />;
  }

  const requestedPath = (location.state as LoginLocationState | null)?.from;
  const redirectTo =
    requestedPath !== undefined && requestedPath !== '/login'
      ? requestedPath
      : '/chat';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearError();

    try {
      await login(email.trim(), password);
      navigate(redirectTo, { replace: true });
    } catch {
      // Текст ошибки уже сохранён в auth.store и отображается в alert.
    }
  }

  return (
    <div className="relative flex min-h-svh overflow-hidden bg-surface text-on-surface">
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

      <div className="fixed right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <section
        aria-labelledby="login-hero-title"
        className="relative hidden w-1/2 flex-col justify-between border-r border-outline-variant p-12 lg:flex"
      >
        <Brand />

        <div className="max-w-md">
          <p className="inline-flex items-center gap-2 rounded-full border border-tertiary/30 bg-tertiary-container px-3 py-1 text-xs font-medium text-on-tertiary-container">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-tertiary"
            />
            Платформа автономных ИИ-агентов
          </p>

          <h1
            id="login-hero-title"
            className="mt-5 font-display text-4xl font-bold leading-tight tracking-tight text-on-surface"
          >
            Один рабочий стол для ваших ИИ-агентов
          </h1>

          <p className="mt-4 text-base leading-relaxed text-on-surface-variant">
            Запускайте задачи, подключайте навыки и наблюдайте за работой
            агентов в реальном времени.
          </p>

          <ul className="mt-8 space-y-3">
            {FEATURES.map((feature) => (
              <li
                key={feature}
                className="flex items-start gap-3 text-sm text-on-surface-variant"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  className="mt-0.5 size-5 shrink-0 text-primary"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="8.25"
                    stroke="currentColor"
                    strokeOpacity="0.35"
                    strokeWidth="1.5"
                  />
                  <path
                    d="m6.5 10.2 2.2 2.2 4.8-4.9"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-on-surface-variant">
          © {CURRENT_YEAR} SkillWharf
        </p>
      </section>

      <main className="relative flex w-full flex-1 items-center justify-center px-5 py-10 sm:px-8 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>

          <div className="rounded-2xl border border-outline-variant bg-surface-container p-6 shadow-xl shadow-primary/5 sm:p-8">
            <h2 className="font-display text-2xl font-bold tracking-tight text-on-surface">
              Вход в SkillWharf
            </h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              Введите данные учётной записи, чтобы продолжить.
            </p>

            <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
              {error !== null && (
                <div
                  id="login-error"
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    className="mt-0.5 size-5 shrink-0 text-error"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="8.25"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M10 6v5"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                    <circle cx="10" cy="14" r="1" fill="currentColor" />
                  </svg>
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-on-surface"
                >
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  required
                  disabled={isSubmitting}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className={INPUT_CLASSES}
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-on-surface"
                >
                  Пароль
                </label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={isPasswordVisible ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    required
                    disabled={isSubmitting}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className={`${INPUT_CLASSES} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={() => setIsPasswordVisible((visible) => !visible)}
                    aria-label={
                      isPasswordVisible ? 'Скрыть пароль' : 'Показать пароль'
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
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                aria-busy={isSubmitting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSubmitting && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="size-4 animate-spin"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="3"
                    />
                    <path
                      d="M21 12a9 9 0 0 0-9-9"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
                {isSubmitting ? 'Входим…' : 'Войти'}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-on-surface-variant">
            Нет аккаунта? Обратитесь к администратору платформы.
          </p>
        </div>
      </main>
    </div>
  );
}
