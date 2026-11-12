import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';

const LandingPage = lazy(() =>
  import('./pages/LandingPage').then((module) => ({
    default: module.LandingPage,
  })),
);

const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({
    default: module.LoginPage,
  })),
);

const OfficePage = lazy(() =>
  import('./pages/OfficePage').then((module) => ({
    default: module.OfficePage,
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

const StorePage = lazy(() =>
  import('./pages/StorePage').then((module) => ({
    default: module.StorePage,
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
        <Route path="/" element={<LandingPage />} />
        <Route path="/welcome" element={<LandingPage />} />
        <Route path="/office" element={<OfficePage />} />
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
        <Route
          path="/store"
          element={
            <ProtectedRoute>
              <StorePage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
