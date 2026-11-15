import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import './index.css';
import { LandingPage } from './pages/LandingPage';

/**
 * Вход для статического лендинга (`landing.html`).
 *
 * Собирается отдельной командой `pnpm build:landing` и разворачивается на
 * постоянном хостинге: витрина и статьи должны открываться, даже когда стенд
 * с приложением выключен. Внутри — только лендинг, без провайдеров запросов
 * и без роутера приложения: все переходы в кабинет ведут на `VITE_APP_URL`.
 */
const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('не найден корневой элемент #root');
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <LandingPage />
    </BrowserRouter>
  </StrictMode>,
);
