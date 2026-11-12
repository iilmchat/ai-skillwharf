import { execFileSync } from 'node:child_process';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

/**
 * Тестовый пользователь создаётся через публичный API перед прогоном. Сида в
 * проекте нет, поэтому регистрация идемпотентна: 409 на повторном запуске
 * означает, что пользователь уже существует.
 */
const TEST_USER = {
  email: 'e2e@skillwharf.test',
  password: 'E2ePassword123!',
};

/** Пополняем баланс, иначе чат блокируется paywall'ом (минимум 0.50). */
const MIN_BALANCE = 1;
const TOPUP_AMOUNT = 10;

const WEB_BASE_URL = (
  process.env.E2E_BASE_URL ?? 'http://localhost:8080'
).replace(/\/$/, '');
const API_BASE_URL = `${WEB_BASE_URL}/api/v1`;

interface AuthProfile {
  role: string;
}

async function loginViaApi(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_BASE_URL}/auth/login`, {
    data: TEST_USER,
  });

  expect(response.ok(), `login failed: ${response.status()}`).toBeTruthy();

  const body = (await response.json()) as { accessToken: string };

  return body.accessToken;
}

async function getProfile(
  request: APIRequestContext,
  accessToken: string,
): Promise<AuthProfile> {
  const response = await request.get(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(response.ok(), `profile failed: ${response.status()}`).toBeTruthy();

  return (await response.json()) as AuthProfile;
}

/** Локальный стек можно править напрямую в контейнере postgres. */
function isLocalStack(): boolean {
  return (
    process.env.E2E_BASE_URL === undefined ||
    /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      process.env.E2E_BASE_URL,
    )
  );
}

function runPsql(sql: string): void {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-lc',
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "${sql.replaceAll('"', '\\"')}"`,
    ],
    { stdio: 'pipe' },
  );
}

/**
 * Установка навыка в API разрешена только администратору. Тестового сида в
 * проекте нет, поэтому повышаем созданного пользователя напрямую в локальной
 * БД. Для удалённого стенда роль должен выдать сид, а промоушен пропускается.
 */
function promoteToAdmin(): void {
  if (!isLocalStack()) {
    return;
  }

  runPsql(
    `UPDATE "User" SET role = 'admin' WHERE email = '${TEST_USER.email}';`,
  );
}

/**
 * При повторном локальном прогоне первый навык магазина уже установлен, а его
 * кнопка заблокирована. Удаляем запись, чтобы сценарий установки проходил
 * каждый раз. В CI база пустая, поэтому запрос ничего не меняет.
 */
function resetStoreSkill(): void {
  if (!isLocalStack()) {
    return;
  }

  runPsql('DELETE FROM "InstalledSkill" WHERE name = \'weather-api\';');
}

async function ensureTestUser(request: APIRequestContext): Promise<void> {
  const register = await request.post(`${API_BASE_URL}/auth/register`, {
    data: TEST_USER,
  });

  // 409 — пользователь уже создан предыдущим прогоном.
  if (!register.ok() && register.status() !== 409) {
    throw new Error(
      `Не удалось создать тестового пользователя: ${register.status()} ${await register.text()}`,
    );
  }

  let accessToken = await loginViaApi(request);
  let profile = await getProfile(request, accessToken);

  if (profile.role !== 'admin') {
    promoteToAdmin();
    accessToken = await loginViaApi(request);
    profile = await getProfile(request, accessToken);
  }

  expect(profile.role, 'тестовый пользователь должен быть admin').toBe('admin');

  const headers = { Authorization: `Bearer ${accessToken}` };

  const balanceResponse = await request.get(`${API_BASE_URL}/billing/balance`, {
    headers,
  });

  expect(
    balanceResponse.ok(),
    `balance failed: ${balanceResponse.status()}`,
  ).toBeTruthy();

  const { balance } = (await balanceResponse.json()) as { balance: string };

  if (Number.parseFloat(balance) >= MIN_BALANCE) {
    return;
  }

  const topup = await request.post(`${API_BASE_URL}/billing/topup`, {
    headers,
    data: {
      amount: TOPUP_AMOUNT,
      description: 'E2E seed balance',
      idempotencyKey: `e2e-seed-${Date.now()}`,
    },
  });

  expect(topup.ok(), `topup failed: ${topup.status()}`).toBeTruthy();
}

async function loginViaUi(page: Page): Promise<void> {
  await page.goto('/login');

  await page.locator('#email').fill(TEST_USER.email);
  await page.locator('#password').fill(TEST_USER.password);
  await page.locator('form button[type="submit"]').click();

  await expect(page).toHaveURL(/\/app\/chat$/);
  // Поле ввода активируется, когда создан диалог и подключён Socket.IO.
  await expect(page.locator('#chat-message')).toBeEnabled();
}

test.beforeAll(async ({ request }) => {
  await ensureTestUser(request);
  resetStoreSkill();
});

test.describe('Дымовые сценарии UI', () => {
  test('неавторизованный пользователь видит лендинг и страницу входа', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /Автономные|Autonomous/,
    );

    await page.getByRole('link', { name: /Войти|Sign in/i }).first().click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('form button[type="submit"]')).toBeVisible();
  });

  test('пользователь входит, отправляет сообщение и получает ответ', async ({
    page,
  }) => {
    await loginViaUi(page);

    const message = `E2E smoke ${Date.now()}`;
    const messages = page.locator('ol[aria-live="polite"] > li');
    // На странице может быть открыт диалог пополнения со своей submit-кнопкой,
    // поэтому ищем кнопку отправки внутри формы чата.
    const chatForm = page
      .locator('form')
      .filter({ has: page.locator('#chat-message') });

    await page.locator('#chat-message').fill(message);
    await chatForm.locator('button[type="submit"]').click();

    await expect(messages).toHaveCount(2, { timeout: 90_000 });
    await expect(messages.nth(0)).toContainText(message);
    await expect(messages.nth(1)).not.toBeEmpty();
  });

  test('в магазине отображаются карточки и работает установка', async ({
    page,
  }) => {
    await loginViaUi(page);

    // Полный переход (`page.goto`) сбросил бы in-memory auth-стор и вернул на
    // /login, поэтому в магазин переходим по ссылке внутри SPA.
    await page.locator('a[href="/app/store"]:visible').first().click();
    await expect(page).toHaveURL(/\/app\/store$/);

    const cards = page.locator('main ul > li > article');

    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(0);

    const firstCard = cards.first();
    await expect(firstCard.getByRole('heading', { level: 2 })).not.toBeEmpty();

    await firstCard
      .getByRole('button', { name: /Установить|Install/i })
      .click();

    // Первый навык запрашивает network, поэтому Vetter показывает
    // подтверждение перед установкой.
    await page
      .getByRole('button', { name: /Всё равно установить|Install anyway/i })
      .click();

    await expect(
      page.getByRole('status').filter({ hasText: /установлен|installed/i }),
    ).toBeVisible();
  });
});
