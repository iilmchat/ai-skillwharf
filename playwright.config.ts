import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-тесты запускаются против уже поднятого стека (`docker compose up -d`).
 * Адрес можно переопределить переменной `E2E_BASE_URL`, например для
 * staging-окружения.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './apps/web/e2e',
  outputDir: './test-results',
  // Тесты делят одну БД и одного тестового пользователя, поэтому идут
  // последовательно в одном воркере.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL,
    // Артефакты сохраняются только при падении и публикуются в CI.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
