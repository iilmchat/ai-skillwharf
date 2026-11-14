#!/usr/bin/env node
/**
 * Идемпотентный сидинг staging-стенда.
 *
 * Что делает:
 *   1. создаёт admin@skillwharf.local (роль admin) и tester@skillwharf.local (роль user);
 *   2. пополняет тестировщику баланс до 10 000 ₽ через POST /billing/topup
 *      (сервисный слой, append-only Ledger не трогаем);
 *   3. устанавливает и включает базовые навыки через SkillsService (API).
 *
 * Пароли генерируются один раз и сохраняются в staging-credentials.txt
 * (600, в .gitignore). Файл переиспользуется при повторных запусках, поэтому
 * скрипт идемпотентен.
 *
 * Запуск (стек уже поднят):
 *   pnpm seed:staging
 *   # или
 *   node --experimental-transform-types scripts/seed-staging.ts
 *
 * Переменные:
 *   STAGING_API_URL            (default http://127.0.0.1:3001/api/v1)
 *   STAGING_CREDENTIALS_FILE   (default ./staging-credentials.txt)
 *   STAGING_TESTER_BALANCE     (default 10000)
 *   STAGING_SEED_SKILLS        (default tavily-search,document-analyzer)
 *   STAGING_POSTGRES_SERVICE   (default postgres)
 *   STAGING_ALLOW_REPEAT_TOPUP (1 — разрешить повторное пополнение, если баланс
 *                              просадили после первого сидинга)
 *   COMPOSE_PROJECT_NAME       (нужен для docker compose exec postgres)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const API_URL = (process.env.STAGING_API_URL ?? 'http://127.0.0.1:3001/api/v1').replace(
  /\/$/,
  '',
);
const CREDENTIALS_FILE = resolve(
  process.env.STAGING_CREDENTIALS_FILE ?? join(REPO_ROOT, 'staging-credentials.txt'),
);
const TARGET_BALANCE = Number(process.env.STAGING_TESTER_BALANCE ?? '10000');
const POSTGRES_SERVICE = process.env.STAGING_POSTGRES_SERVICE ?? 'postgres';
const ALLOW_REPEAT_TOPUP = process.env.STAGING_ALLOW_REPEAT_TOPUP === '1';
const SEED_SKILLS = (process.env.STAGING_SEED_SKILLS ?? 'tavily-search,document-analyzer')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);

const ADMIN_EMAIL = 'admin@skillwharf.local';
const TESTER_EMAIL = 'tester@skillwharf.local';

const credentialsSchema = z.object({
  admin: z.object({ email: z.string().min(1), password: z.string().min(1) }),
  tester: z.object({ email: z.string().min(1), password: z.string().min(1) }),
});

type Credentials = z.infer<typeof credentialsSchema>;

const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

const profileSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  role: z.string().min(1),
});

const balanceSchema = z.object({
  balance: z.string(),
  heldBalance: z.string().optional(),
});

const installedSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isEnabled: z.boolean(),
});

const apiErrorSchema = z.object({
  statusCode: z.number().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
  error: z.string().optional(),
});

class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

interface Account {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly token: string;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function generatePassword(): string {
  // 24 байта энтропии ≈ 32 символа base64url; zod и API требуют ≥ 8.
  return randomBytes(24).toString('base64url');
}

function loadCredentials(): Credentials {
  if (!existsSync(CREDENTIALS_FILE)) {
    const fresh: Credentials = {
      admin: { email: ADMIN_EMAIL, password: generatePassword() },
      tester: { email: TESTER_EMAIL, password: generatePassword() },
    };

    writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    chmodSync(CREDENTIALS_FILE, 0o600);
    log(`credentials: создан ${CREDENTIALS_FILE}`);

    return fresh;
  }

  const parsed = credentialsSchema.safeParse(
    JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as unknown,
  );

  if (!parsed.success) {
    throw new SeedError(
      `файл ${CREDENTIALS_FILE} повреждён: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  log(`credentials: переиспользую ${CREDENTIALS_FILE}`);
  return parsed.data;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly token?: string;
  readonly body?: unknown;
}

async function request(
  path: string,
  options: RequestOptions,
): Promise<{ status: number; payload: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let payload: unknown = null;

  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }

  return { status: response.status, payload };
}

function describeError(payload: unknown): string {
  const parsed = apiErrorSchema.safeParse(payload);

  if (!parsed.success) {
    return JSON.stringify(payload).slice(0, 200);
  }

  const { message, statusCode, error } = parsed.data;

  if (Array.isArray(message)) {
    return `${statusCode ?? ''} ${message.join('; ')}`.trim();
  }

  return `${statusCode ?? ''} ${message ?? error ?? ''}`.trim();
}

async function login(email: string, password: string): Promise<string | null> {
  const { status, payload } = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (status === 401 || status === 400) {
    return null;
  }

  if (status !== 200 && status !== 201) {
    throw new SeedError(`login ${email}: ${describeError(payload)}`);
  }

  const parsed = authTokensSchema.safeParse(payload);

  if (!parsed.success) {
    throw new SeedError(`login ${email}: неожиданный ответ ${JSON.stringify(payload).slice(0, 200)}`);
  }

  return parsed.data.accessToken;
}

async function register(email: string, password: string): Promise<'created' | 'exists'> {
  const { status, payload } = await request('/auth/register', {
    method: 'POST',
    body: { email, password },
  });

  if (status === 201) {
    return 'created';
  }

  if (status === 409) {
    return 'exists';
  }

  throw new SeedError(`register ${email}: ${describeError(payload)}`);
}

function promoteToAdmin(email: string): void {
  // У API нет эндпоинта смены роли, поэтому роль выставляется напрямую в
  // таблице User. Ledger, Wallet и InstalledSkill это не затрагивает.
  const sql = `UPDATE "User" SET role = 'admin', "updatedAt" = now() WHERE email = '${email.replace(/'/g, "''")}' AND role <> 'admin';`;
  const script = `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc ${JSON.stringify(sql)}`;

  try {
    execFileSync(
      'docker',
      ['compose', 'exec', '-T', POSTGRES_SERVICE, 'sh', '-lc', script],
      { stdio: 'pipe', cwd: REPO_ROOT },
    );
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    throw new SeedError(
      `не удалось выставить роль admin для ${email}. Убедитесь, что стек поднят (docker compose ps) и доступен psql.\n${stderr}`,
    );
  }
}

async function profileOf(token: string): Promise<z.infer<typeof profileSchema>> {
  const { status, payload } = await request('/auth/me', { token });

  if (status !== 200) {
    throw new SeedError(`/auth/me: ${describeError(payload)}`);
  }

  const parsed = profileSchema.safeParse(payload);

  if (!parsed.success) {
    throw new SeedError(`/auth/me: неожиданный ответ ${JSON.stringify(payload).slice(0, 200)}`);
  }

  return parsed.data;
}

async function ensureAccount(
  email: string,
  password: string,
  role: 'admin' | 'user',
): Promise<Account> {
  let token = await login(email, password);

  if (token === null) {
    const outcome = await register(email, password);

    if (outcome === 'exists') {
      throw new SeedError(
        `пользователь ${email} уже существует с другим паролем. ` +
          `Удалите ${CREDENTIALS_FILE} и пользователя, либо восстановите пароль вручную.`,
      );
    }

    log(`account: создан ${email} (${role})`);
    token = await login(email, password);

    if (token === null) {
      throw new SeedError(`login ${email} сразу после регистрации не удался`);
    }
  }

  let profile = await profileOf(token);

  if (role === 'admin' && profile.role !== 'admin') {
    promoteToAdmin(email);
    log(`account: ${email} повышен до admin`);

    token = await login(email, password);

    if (token === null) {
      throw new SeedError(`login ${email} после смены роли не удался`);
    }

    profile = await profileOf(token);
  }

  log(`account: ${email} — роль ${profile.role}`);

  return { id: profile.id, email: profile.email, role: profile.role, token };
}

async function balanceOf(token: string): Promise<number> {
  const { status, payload } = await request('/billing/balance', { token });

  if (status !== 200) {
    throw new SeedError(`/billing/balance: ${describeError(payload)}`);
  }

  const parsed = balanceSchema.safeParse(payload);

  if (!parsed.success) {
    throw new SeedError(`/billing/balance: неожиданный ответ ${JSON.stringify(payload).slice(0, 200)}`);
  }

  return Number.parseFloat(parsed.data.balance);
}

async function topUp(
  actor: Account,
  targetUserId: string,
  amount: number,
  idempotencyKey: string,
): Promise<void> {
  const { status, payload } = await request('/billing/topup', {
    method: 'POST',
    token: actor.token,
    body: {
      userId: targetUserId,
      amount,
      description: 'Staging seed balance',
      idempotencyKey,
    },
  });

  if (status === 409) {
    throw new SeedError(
      '/billing/topup: idempotencyKey уже использован другим пользователем. ' +
        'Обычно это значит, что стенд сидили раньше с другим userId. ' +
        'Для разового пополнения запустите с STAGING_ALLOW_REPEAT_TOPUP=1.',
    );
  }

  if (status !== 200 && status !== 201) {
    throw new SeedError(`/billing/topup: ${describeError(payload)}`);
  }
}

function findSkillFile(name: string): string {
  const matches = globSync('starter-skills/**/SKILL.md', { cwd: REPO_ROOT });

  for (const relative of matches) {
    const file = join(REPO_ROOT, relative);
    const frontmatter = readFileSync(file, 'utf8').match(/^name:\s*"?([^"\n]+)"?/m);

    if (frontmatter !== null && frontmatter[1].trim() === name) {
      return file;
    }
  }

  throw new SeedError(`навык ${name} не найден в starter-skills/**/SKILL.md`);
}

async function installSkill(admin: Account, name: string): Promise<void> {
  const fileContent = readFileSync(findSkillFile(name), 'utf8');

  const { status, payload } = await request('/skills/install', {
    method: 'POST',
    token: admin.token,
    body: { fileContent },
  });

  if (status !== 200 && status !== 201) {
    throw new SeedError(`/skills/install ${name}: ${describeError(payload)}`);
  }

  const parsed = installedSkillSchema.safeParse(payload);

  if (!parsed.success) {
    throw new SeedError(`/skills/install ${name}: неожиданный ответ ${JSON.stringify(payload).slice(0, 200)}`);
  }

  const skill = parsed.data;

  if (skill.isEnabled) {
    log(`skill: ${name} установлен и включён`);
    return;
  }

  const toggled = await request(`/skills/${skill.id}/toggle`, {
    method: 'PATCH',
    token: admin.token,
    body: { isEnabled: true },
  });

  if (toggled.status !== 200) {
    throw new SeedError(`/skills/${skill.id}/toggle ${name}: ${describeError(toggled.payload)}`);
  }

  log(`skill: ${name} установлен и включён (после toggle)`);
}

async function main(): Promise<void> {
  log(`API: ${API_URL}`);

  const credentials = loadCredentials();
  const admin = await ensureAccount(credentials.admin.email, credentials.admin.password, 'admin');
  const tester = await ensureAccount(credentials.tester.email, credentials.tester.password, 'user');

  const balance = await balanceOf(tester.token);
  const delta = TARGET_BALANCE - balance;

  if (delta > 0) {
    const idempotencyKey = ALLOW_REPEAT_TOPUP
      ? `staging-seed-topup-${tester.id}-${Date.now()}`
      : `staging-seed-topup-${tester.id}-${TARGET_BALANCE}`;

    await topUp(admin, tester.id, delta, idempotencyKey);
    const after = await balanceOf(tester.token);

    if (after < TARGET_BALANCE) {
      log(
        `balance: пополнение на ${delta.toFixed(2)} не применилось (ключ идемпотентности уже использован).\n` +
          `         Для повторного пополнения запустите с STAGING_ALLOW_REPEAT_TOPUP=1.`,
      );
    } else {
      log(`balance: пополнено на ${delta.toFixed(2)} ₽ → ${after.toFixed(2)} ₽`);
    }
  } else {
    log(`balance: уже ${balance.toFixed(2)} ₽, пополнение не требуется`);
  }

  for (const name of SEED_SKILLS) {
    await installSkill(admin, name);
  }

  log('');
  log('Готово. Учётные данные для тестировщиков:');
  log(`  ${admin.email} (admin)  пароль в ${CREDENTIALS_FILE}`);
  log(`  ${tester.email} (user)  пароль в ${CREDENTIALS_FILE}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`seed-staging: ${message}\n`);
  process.exitCode = 1;
});
