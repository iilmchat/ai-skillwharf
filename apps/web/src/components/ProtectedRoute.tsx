import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/auth.store';

interface ProtectedRouteProps {
  children: ReactNode;
  /** Если задано, пускает только пользователей с одной из этих ролей. */
  allowedRoles?: readonly string[];
}

function AccessDenied() {
  const { t } = useTranslation();

  return (
    <div className="grid min-h-svh place-items-center bg-surface px-4 text-on-surface">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-error/30 bg-error-container p-6 text-on-error-container"
      >
        <h1 className="font-display text-xl font-bold">
          {t('admin.errors.forbiddenTitle')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed">
          {t('admin.errors.forbiddenBody')}
        </p>
        <Link
          to="/app/chat"
          className="mt-5 inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('admin.backToChat')}
        </Link>
      </div>
    </div>
  );
}

/** Пропускает дальше только при наличии токена и подходящей роли. */
export function ProtectedRoute({
  children,
  allowedRoles,
}: ProtectedRouteProps) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const isInitializing = useAuthStore((state) => state.isInitializing);
  const { t } = useTranslation();
  const location = useLocation();

  // Пока идёт восстановление сессии после F5, не отправляем на /login.
  if (isInitializing) {
    return (
      <div className="grid min-h-svh place-items-center bg-surface text-on-surface">
        <div
          role="status"
          aria-label={t('common.loading')}
          className="size-8 animate-spin rounded-full border-2 border-outline border-t-primary"
        />
      </div>
    );
  }

  if (accessToken === null || user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (
    allowedRoles !== undefined &&
    !allowedRoles.includes(user.role)
  ) {
    return <AccessDenied />;
  }

  return children;
}
