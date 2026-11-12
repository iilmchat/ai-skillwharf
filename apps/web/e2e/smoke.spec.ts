import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
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

const VIEWER_USER = {
  email: 'viewer@skillwharf.test',
  password: 'ViewerPassword123!',
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

interface MockLlmServer {
  /** Адрес, доступный из контейнера api через host.docker.internal. */
  baseUrl: string;
  close: () => Promise<void>;
}

interface LlmRouteView {
  id: string;
  isActive: boolean;
}

function writeSseChunk(
  response: ServerResponse,
  delta: unknown,
  finishReason: string | null,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'e2e-mock',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

/**
 * Детерминированная OpenAI-совместимая LLM для E2E: на первый запрос просит
 * `execute_sandbox_code`, после результата инструмента отдаёт финальный текст.
 * Так escrow-сценарий не зависит от внешней модели и работает в CI.
 */
async function startMockLlmServer(): Promise<MockLlmServer> {
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      !request.url?.endsWith('/chat/completions')
    ) {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string }>;
      };
      const hasToolResult = (payload.messages ?? []).some(
        (message) => message.role === 'tool',
      );

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (hasToolResult) {
        writeSseChunk(
          response,
          { role: 'assistant', content: 'Готово: e2e-escrow' },
          null,
        );
        writeSseChunk(response, {}, 'stop');
      } else {
        writeSseChunk(
          response,
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_escrow',
                type: 'function',
                function: {
                  name: 'execute_sandbox_code',
                  arguments: JSON.stringify({ code: 'print("e2e-escrow")' }),
                },
              },
            ],
          },
          null,
        );
        writeSseChunk(response, {}, 'tool_calls');
      }

      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;

  return {
    baseUrl: `http://host.docker.internal:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function getBalance(
  request: APIRequestContext,
  accessToken: string,
): Promise<number> {
  const response = await request.get(`${API_BASE_URL}/billing/balance`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  expect(response.ok(), `balance failed: ${response.status()}`).toBeTruthy();

  const { balance } = (await response.json()) as { balance: string };

  return Number.parseFloat(balance);
}

async function createMockRoute(
  request: APIRequestContext,
  accessToken: string,
  baseUrl: string,
): Promise<{ routeId: string; restore: () => Promise<void> }> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const listResponse = await request.get(`${API_BASE_URL}/admin/llm-routes`, {
    headers,
  });

  expect(listResponse.ok()).toBeTruthy();

  const routes = (await listResponse.json()) as LlmRouteView[];
  const activeRoutes = routes.filter((route) => route.isActive);

  for (const route of activeRoutes) {
    const disabled = await request.patch(
      `${API_BASE_URL}/admin/llm-routes/${route.id}`,
      { headers, data: { isActive: false } },
    );
    expect(disabled.ok()).toBeTruthy();
  }

  const disabledResponse = await request.get(
    `${API_BASE_URL}/admin/llm-routes`,
    { headers },
  );
  const stillActive = (
    (await disabledResponse.json()) as LlmRouteView[]
  ).filter((route) => route.isActive);

  expect(
    stillActive,
    'перед тестом не должно остаться активных маршрутов',
  ).toEqual([]);

  const created = await request.post(`${API_BASE_URL}/admin/llm-routes`, {
    headers,
    data: {
      name: `e2e-mock-${Date.now()}`,
      modelName: 'e2e-mock',
      baseUrl,
      priority: 0,
      isActive: true,
    },
  });

  expect(created.ok(), `route create: ${created.status()}`).toBeTruthy();

  const { id: routeId } = (await created.json()) as { id: string };

  return {
    routeId,
    restore: async () => {
      await request.delete(`${API_BASE_URL}/admin/llm-routes/${routeId}`, {
        headers,
      });

      for (const route of activeRoutes) {
        await request.patch(`${API_BASE_URL}/admin/llm-routes/${route.id}`, {
          headers,
          data: { isActive: true },
        });
      }
    },
  };
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

    await page
      .getByRole('link', { name: /Войти|Sign in/i })
      .first()
      .click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('form button[type="submit"]')).toBeVisible();
  });

  test('обычный пользователь не видит пульт управления', async ({
    page,
    request,
  }) => {
    const registration = await request.post(`${API_BASE_URL}/auth/register`, {
      data: VIEWER_USER,
    });

    if (!registration.ok() && registration.status() !== 409) {
      throw new Error(
        `Не удалось создать viewer-пользователя: ${registration.status()}`,
      );
    }

    await page.goto('/login');
    await page.fill('#email', VIEWER_USER.email);
    await page.fill('#password', VIEWER_USER.password);
    await page.click('form button[type="submit"]');

    await expect(page).toHaveURL(/\/app\/chat$/);
    await expect(page.locator('#chat-message')).toBeEnabled();
    await expect(page.locator('a[href="/admin"]')).toHaveCount(0);
  });

  test('администратор открывает пульт управления', async ({ page }) => {
    await loginViaUi(page);

    const adminLink = page.locator('a[href="/admin"]');
    await expect(adminLink).toBeVisible();
    await adminLink.click();

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      /Пульт управления|Control plane/,
    );
    await expect(
      page.getByRole('tab', { name: /Промпты|Prompts/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('tab', { name: /LLM Роутер|LLM Router/ }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: /Аудит|Audit/ })).toBeVisible();

    await page.getByRole('tab', { name: /Аудит|Audit/ }).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
  });

  test('в LLM-роутере можно выбрать провайдера', async ({ page }) => {
    await loginViaUi(page);

    await page.locator('a[href="/admin"]').click();
    await expect(page).toHaveURL(/\/admin$/);
    await page
      .getByRole('tab', { name: /LLM Роутер|LLM Router/ })
      .click();

    await page
      .getByRole('button', { name: /Добавить правило|Add rule/ })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const provider = dialog.locator('#admin-route-provider');
    await expect(provider).toHaveValue('OpenAI');
    await expect(provider.locator('option')).toHaveCount(3);

    await provider.selectOption('YandexGPT');
    await expect(dialog).toContainText('gpt://');

    await provider.selectOption('GigaChat');
    await expect(dialog).toContainText(/OAuth/i);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
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

  test('офис получает события агента и одобряет действие', async ({ page }) => {
    await loginViaUi(page);

    const chatForm = page
      .locator('form')
      .filter({ has: page.locator('#chat-message') });

    await page.locator('#chat-message').fill(`E2E office ${Date.now()}`);
    await chatForm.locator('button[type="submit"]').click();

    await expect(page.locator('ol[aria-live="polite"] > li')).toHaveCount(2, {
      timeout: 90_000,
    });

    await page.locator('a[href^="/app/office"]:visible').first().click();
    await expect(page).toHaveURL(/\/app\/office/);

    const nova = page.locator('main article').filter({ hasText: 'Nova' });
    await expect(nova).toContainText(/Задача завершена|Task finished/);

    await nova.getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const leo = page.locator('main article').filter({ hasText: 'Leo' });
    await leo.getByRole('button').click();
    await dialog
      .getByRole('button', { name: /Одобрить действие|Approve action/i })
      .click();

    await expect(dialog).toContainText(/Действие одобрено|Action approved/);
    await expect(dialog).toContainText(/Печатает|Typing/);
  });

  test('в магазине работают категории навыков', async ({ page }) => {
    await loginViaUi(page);

    await page.locator('a[href="/app/store"]:visible').first().click();
    await expect(page).toHaveURL(/\/app\/store$/);
    await expect(page.getByRole('tab')).toHaveCount(9);

    await page.getByRole('tab', { name: /Поиск/ }).click();
    await expect(page.locator('main ul > li > article')).toHaveCount(2);

    await page.getByRole('tab', { name: /Коммуникации/ }).click();
    await expect(page.locator('main ul > li > article')).toHaveCount(1);
    await expect(page.locator('main ul > li > article')).toContainText(
      'messenger-connector',
    );

    await page.getByRole('tab', { name: /Продуктивность/ }).click();
    await expect(page.locator('main ul > li > article')).toHaveCount(5);

    await page.getByRole('tab', { name: /Разработка/ }).click();
    await expect(page.locator('main ul > li > article')).toHaveCount(6);

    await page.getByRole('tab', { name: /Финансы/ }).click();
    const financeCards = page.locator('main ul > li > article');
    await expect(financeCards).toHaveCount(4);
    await expect(
      financeCards.filter({ hasText: 'fraud-shield-audit' }),
    ).toContainText('500,00 ₽ / результат');
    await expect(
      financeCards.filter({ hasText: 'profit-leak-detector' }),
    ).toContainText('300,00 ₽ / вызов');
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

  test('эскроу: sandbox-вызов ждёт одобрения и списывает баланс', async ({
    page,
    request,
  }) => {
    const accessToken = await loginViaApi(request);
    const headers = { Authorization: `Bearer ${accessToken}` };

    const topup = await request.post(`${API_BASE_URL}/billing/topup`, {
      headers,
      data: {
        amount: 10,
        description: 'E2E escrow balance',
        idempotencyKey: `e2e-escrow-${Date.now()}`,
      },
    });

    expect(topup.ok(), `topup failed: ${topup.status()}`).toBeTruthy();

    const balanceBefore = await getBalance(request, accessToken);
    const mockLlm = await startMockLlmServer();
    let mockRoute: Awaited<ReturnType<typeof createMockRoute>> | null = null;

    try {
      mockRoute = await createMockRoute(request, accessToken, mockLlm.baseUrl);

      await loginViaUi(page);

      const chatForm = page
        .locator('form')
        .filter({ has: page.locator('#chat-message') });

      await page
        .locator('#chat-message')
        .fill(`E2E escrow ${Date.now()}: выполни код в песочнице`);
      await chatForm.locator('button[type="submit"]').click();

      // Граф остановился перед execute_sandbox_code и ждёт approve_action,
      // поэтому ответа в чате ещё нет — переходим в офис.
      await page.locator('a[href^="/app/office"]:visible').first().click();
      await expect(page).toHaveURL(/\/app\/office/);

      const nova = page.locator('main article').filter({ hasText: 'Nova' });
      await expect(nova).toContainText(
        /Ждёт одобрения|Ожидает одобрения|Awaiting approval/,
        { timeout: 30_000 },
      );

      await nova.getByRole('button').click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole('button', {
          name: /Одобрить действие|Approve action/i,
        })
        .click();

      await expect(dialog).toContainText(/Действие одобрено|Action approved/);

      // Списание происходит после одобрения, до запуска sandbox-контейнера.
      await expect
        .poll(async () => getBalance(request, accessToken), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
        })
        .toBeLessThan(balanceBefore);
    } finally {
      await mockRoute?.restore();
      await mockLlm.close();
    }
  });
});
