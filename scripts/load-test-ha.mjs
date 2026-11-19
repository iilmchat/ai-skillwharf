#!/usr/bin/env node
//
// Sprint 34 / HA-34.1: нагрузочный тест HA-кластера SkillWharf.
//
//   node scripts/load-test-ha.mjs --dry-run
//   pnpm loadtest:ha --url https://app.example.com --token <jwt> \
//     --concurrency 30 --requests 300
//
// Запросы распределяются по трём эндпоинтам: readiness, публичный каталог
// навыков и чат (с Bearer-токеном). Успех — отсутствие 5xx и сетевых ошибок;
// p50/p95/p99 latency выводятся в миллисекундах.

/** @typedef {{ url: string, concurrency: number, requests: number, token: string, dryRun: boolean }} Options */

const DEFAULT_URL = 'http://localhost:8080';
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_REQUESTS = 100;
const REQUEST_TIMEOUT_MS = 15_000;

const ENDPOINTS = [
  { path: '/api/v1/health/ready', auth: false },
  { path: '/api/v1/marketplace/skills', auth: false },
  { path: '/api/v1/chat/send', auth: true },
];

function usage() {
  console.log(
    [
      'Использование: node scripts/load-test-ha.mjs [опции]',
      '',
      '  --url URL          базовый URL (по умолчанию http://localhost:8080)',
      '  --concurrency N    параллельных воркеров (по умолчанию 20)',
      '  --requests N       всего запросов (по умолчанию 100)',
      '  --token TOKEN      JWT для /api/v1/chat/send',
      '  --dry-run          только валидация и расчёт перцентилей',
      '  -h, --help         показать эту справку',
    ].join('\n'),
  );
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    url: DEFAULT_URL,
    concurrency: DEFAULT_CONCURRENCY,
    requests: DEFAULT_REQUESTS,
    token: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (!['--url', '--concurrency', '--requests', '--token'].includes(arg)) {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} требует значение`);
    }
    if (arg === '--url') options.url = value;
    if (arg === '--token') options.token = value;
    if (arg === '--concurrency') options.concurrency = Number(value);
    if (arg === '--requests') options.requests = Number(value);
    i += 1;
  }

  const parsedUrl = new URL(options.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('--url должен быть http(s) URL');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 500) {
    throw new Error('--concurrency должен быть целым от 1 до 500');
  }
  if (!Number.isInteger(options.requests) || options.requests < 1 || options.requests > 100_000) {
    throw new Error('--requests должен быть целым от 1 до 100000');
  }
  if (options.concurrency > options.requests) {
    throw new Error('--concurrency не должен превышать --requests');
  }

  return options;
}

/**
 * Nearest-rank percentile.
 * @param {number[]} values
 * @param {number} rank
 */
function percentile(values, rank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(rank * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

/** @param {number[]} latencies */
function printStats(latencies) {
  console.log(
    [
      `Запросов: ${latencies.length}`,
      `p50: ${percentile(latencies, 0.5).toFixed(1)} мс`,
      `p95: ${percentile(latencies, 0.95).toFixed(1)} мс`,
      `p99: ${percentile(latencies, 0.99).toFixed(1)} мс`,
    ].join('\n'),
  );
}

function printTargets(options) {
  for (const endpoint of ENDPOINTS) {
    const status =
      endpoint.auth && options.token === ''
        ? 'пропущен (нет --token)'
        : 'участвует';
    console.log(`  ${endpoint.path} — ${status}`);
  }
}

/**
 * @param {string} baseUrl
 * @param {{ path: string, auth: boolean }} endpoint
 * @param {string} token
 * @returns {Promise<{ status: number, ms: number }>}
 */
async function sendRequest(baseUrl, endpoint, token) {
  const headers = { 'user-agent': 'SkillWharf-LoadTest/0.1.0' };
  if (endpoint.auth && token !== '') {
    headers.authorization = `Bearer ${token}`;
  }

  const started = performance.now();
  const response = await fetch(`${baseUrl}${endpoint.path}`, {
    method: endpoint.path === '/api/v1/chat/send' ? 'POST' : 'GET',
    headers: {
      ...headers,
      ...(endpoint.path === '/api/v1/chat/send'
        ? { 'content-type': 'application/json' }
        : {}),
    },
    ...(endpoint.path === '/api/v1/chat/send'
      ? { body: JSON.stringify({ message: 'load test ping', stream: false }) }
      : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Тело не читаем: важен только статус и время до заголовков.
  await response.body?.cancel();
  return { status: response.status, ms: performance.now() - started };
}

/** @param {Options} options */
async function runLoadTest(options) {
  const baseUrl = options.url.replace(/\/$/, '');
  const targets = ENDPOINTS.filter((endpoint) => !endpoint.auth || options.token !== '');
  const latencies = [];
  const failures = [];
  let next = 0;

  async function worker() {
    while (next < options.requests) {
      const index = next;
      next += 1;
      const endpoint = targets[index % targets.length];
      try {
        const result = await sendRequest(baseUrl, endpoint, options.token);
        latencies.push(result.ms);
        if (result.status >= 500) {
          failures.push(`${endpoint.path} → HTTP ${result.status}`);
        }
      } catch (error) {
        failures.push(
          `${endpoint.path} → ${error instanceof Error ? error.message : 'сетевая ошибка'}`,
        );
      }
    }
  }

  console.log(
    `Нагрузка: ${options.requests} запросов, ${options.concurrency} воркеров, ${baseUrl}`,
  );
  printTargets(options);
  const started = performance.now();
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  const totalMs = performance.now() - started;

  printStats(latencies);
  console.log(`Общее время: ${(totalMs / 1000).toFixed(2)} с`);
  console.log(`RPS: ${(options.requests / (totalMs / 1000)).toFixed(1)}`);
  console.log(`5xx/сетевые ошибки: ${failures.length}`);

  if (failures.length > 0) {
    for (const failure of failures.slice(0, 10)) {
      console.error(`FAIL ${failure}`);
    }
    process.exit(1);
  }
  console.log('OK: 5xx и сетевых ошибок нет.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    console.log(
      `DRY RUN: url=${options.url}, concurrency=${options.concurrency}, requests=${options.requests}`,
    );
    printTargets(options);
    // Синтетическая выборка — проверяем расчёт перцентилей без сети.
    const synthetic = Array.from({ length: options.requests }, (_, index) => index + 1);
    printStats(synthetic);
    console.log('OK: аргументы валидны, перцентили рассчитаны.');
    return;
  }

  await runLoadTest(options);
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
