import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';

const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({
    default: module.LoginPage,
  })),
);

const ChatPage = lazy(() =>
  import('./pages/ChatPage').then((module) => ({
    default: module.ChatPage,
  })),
);

const SkillsPage = lazy(() =>
  import('./pages/SkillsPage').then((module) => ({
    default: module.SkillsPage,
  })),
);

function RouteFallback() {
  const { t } = useTranslation();

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

function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/chat"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/skills"
          element={
            <ProtectedRoute>
              <SkillsPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
