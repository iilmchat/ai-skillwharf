#!/usr/bin/env node
//
// Sprint 29 / EVAL-29.1 + EVAL-29.3: валидация Golden Datasets и прогон Evals.
//
//   node scripts/run-evals.mjs --validate-only
//   node scripts/run-evals.mjs --api-url http://127.0.0.1:8080 \
//     --prompt-id prompt-1 --version-id v2
//
// Без --api-url проверяется только структура датасетов. В режиме прогона
// используется POST /api/v1/prompts/:id/evals/run (см. PromptsController);
// ответ — EvalRunView из apps/api/src/prompts/prompt-eval.schemas.ts:
//   { results: [{ caseId, trackId, verdict: { passed, reasoning, score } }],
//     passRate, passedCases, totalCases, status, ... }
// Exit code 1, если общий pass rate ниже EVALS_MIN_PASS_RATE (по умолчанию 0.85).

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS_DIR = path.join(ROOT, 'evals', 'datasets');
const TRACKS = 'ABCDEFGHIJKL'.split('');
const DEFAULT_MIN_PASS_RATE = 0.85;

function parseArgs(argv) {
  const args = {
    validateOnly: false,
    apiUrl: '',
    promptId: '',
    versionId: '',
    minPassRate: Number(process.env.EVALS_MIN_PASS_RATE ?? DEFAULT_MIN_PASS_RATE),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--validate-only') {
      args.validateOnly = true;
    } else if (arg === '--api-url' || arg === '--prompt-id' || arg === '--version-id' || arg === '--min-pass-rate') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} требует значение`);
      }
      if (arg === '--api-url') args.apiUrl = value;
      if (arg === '--prompt-id') args.promptId = value;
      if (arg === '--version-id') args.versionId = value;
      if (arg === '--min-pass-rate') args.minPassRate = Number(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Использование: node scripts/run-evals.mjs [--validate-only] [--api-url URL --prompt-id ID --version-id ID] [--min-pass-rate 0.85]');
      process.exit(0);
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minPassRate) || args.minPassRate < 0 || args.minPassRate > 1) {
    throw new Error('min pass rate должен быть числом от 0 до 1');
  }
  return args;
}

async function loadDatasets() {
  const files = (await readdir(DATASETS_DIR))
    .filter((name) => /^track-[a-l]\.json$/.test(name))
    .sort();
  const datasets = [];
  for (const file of files) {
    const raw = await readFile(path.join(DATASETS_DIR, file), 'utf8');
    datasets.push({ file, data: JSON.parse(raw) });
  }
  return datasets;
}

function fail(message) {
  console.error(`ОШИБКА: ${message}`);
  process.exitCode = 1;
}

function validate(datasets) {
  const errors = [];
  const ids = new Set();
  const seenTracks = new Set();

  for (const track of TRACKS) {
    if (!datasets.some(({ data }) => data?.trackId === track)) {
      errors.push(`отсутствует датасет трека ${track}`);
    }
  }

  for (const { file, data } of datasets) {
    const trackId = data?.trackId;
    if (!TRACKS.includes(trackId)) {
      errors.push(`${file}: некорректный trackId ${trackId}`);
      continue;
    }
    if (seenTracks.has(trackId)) {
      errors.push(`${file}: дублирующийся датасет трека ${trackId}`);
    }
    seenTracks.add(trackId);

    if (!Array.isArray(data.cases) || data.cases.length < 2) {
      errors.push(`${file}: ожидается минимум 2 кейса`);
      continue;
    }

    for (const [index, item] of data.cases.entries()) {
      const label = `${file} кейс ${index + 1}${item?.id ? ` (${item.id})` : ''}`;
      if (!item || typeof item !== 'object') {
        errors.push(`${label}: не объект`);
        continue;
      }
      if (typeof item.id !== 'string' || item.id.length === 0) {
        errors.push(`${label}: пустой id`);
      } else if (ids.has(item.id)) {
        errors.push(`${label}: дублирующийся id`);
      } else {
        ids.add(item.id);
      }
      if (item.trackId !== trackId) {
        errors.push(`${label}: trackId не совпадает с файлом (${item.trackId} != ${trackId})`);
      }
      if (typeof item.title !== 'string' || item.title.trim().length === 0) {
        errors.push(`${label}: пустой title`);
      }
      if (typeof item.input !== 'string' || item.input.trim().length === 0) {
        errors.push(`${label}: пустой input`);
      }
      if (!Array.isArray(item.expectedTools) || item.expectedTools.length === 0 ||
          item.expectedTools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
        errors.push(`${label}: пустой или некорректный expectedTools`);
      }
      if (typeof item.requiresHitl !== 'boolean') {
        errors.push(`${label}: requiresHitl должен быть boolean`);
      }
      const rubric = item.rubric;
      if (!rubric || typeof rubric !== 'object') {
        errors.push(`${label}: отсутствует rubric`);
      } else {
        for (const key of ['required', 'forbidden']) {
          if (!Array.isArray(rubric[key]) || rubric[key].length === 0 ||
              rubric[key].some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
            errors.push(`${label}: пустой или некорректный rubric.${key}`);
          }
        }
      }
    }
  }

  return errors;
}

function printTable(rows) {
  const trackWidth = Math.max(6, ...rows.map((row) => row.track.length));
  const header = `| ${'Трек'.padEnd(trackWidth)} | Всего | Pass | Fail | Pass rate |`;
  const divider = `| ${'-'.repeat(trackWidth)} | ---: | ---: | ---: | ---: |`;
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    const rate = row.total === 0 ? '—' : `${(row.passed / row.total * 100).toFixed(1)}%`;
    console.log(`| ${row.track.padEnd(trackWidth)} | ${row.total} | ${row.passed} | ${row.failed} | ${rate} |`);
  }
}

async function runEvals(datasets, args) {
  // API ожидает плоский массив rubric (как datasetRubricSchema в
  // prompt-eval.schemas.ts): required + forbidden с префиксом «НЕ:».
  const cases = datasets.flatMap(({ data }) => data.cases).map((item) => ({
    ...item,
    rubric: [
      ...item.rubric.required,
      ...item.rubric.forbidden.map((entry) => `НЕ: ${entry}`),
    ],
  }));
  const byId = new Map(cases.map((item) => [item.id, item]));
  const endpoint = `${args.apiUrl.replace(/\/$/, '')}/api/v1/prompts/${encodeURIComponent(args.promptId)}/evals/run`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // evalCaseSchema требует versionId в теле (promptId уже в path).
    body: JSON.stringify({ versionId: args.versionId, cases }),
  });
  if (!response.ok) {
    throw new Error(`API вернул ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.results)) {
    throw new Error('В ответе API нет массива results (EvalRunView)');
  }
  if (payload.status !== undefined && !['running', 'passed', 'failed'].includes(payload.status)) {
    throw new Error(`Некорректный status в EvalRunView: ${payload.status}`);
  }

  const rows = TRACKS.map((track) => ({ track, total: 0, passed: 0, failed: 0 }));
  const rowByTrack = new Map(rows.map((row) => [row.track, row]));
  const seen = new Set();

  for (const result of payload.results) {
    const caseId = result?.caseId;
    const item = byId.get(caseId);
    if (!item) {
      fail(`API вернул неизвестный caseId: ${caseId}`);
      continue;
    }
    if (seen.has(caseId)) {
      fail(`API вернул дублирующийся caseId: ${caseId}`);
      continue;
    }
    const verdict = result?.verdict;
    if (typeof verdict?.passed !== 'boolean') {
      fail(`API вернул некорректный verdict для ${caseId}`);
      continue;
    }
    seen.add(caseId);
    const row = rowByTrack.get(item.trackId);
    row.total += 1;
    if (verdict.passed) {
      row.passed += 1;
    } else {
      row.failed += 1;
      console.error(`FAIL ${caseId} (${verdict.reasoning ?? 'нет обоснования'})`);
    }
  }

  const missing = cases.filter((item) => !seen.has(item.id));
  if (missing.length > 0) {
    fail(`API не вернул результаты для ${missing.length} кейсов: ${missing.map((item) => item.id).join(', ')}`);
  }

  printTable(rows);

  const total = cases.length;
  const passed = rows.reduce((sum, row) => sum + row.passed, 0);
  const rate = total === 0 ? 0 : passed / total;
  console.log(`\nИтого: ${passed}/${total} (${(rate * 100).toFixed(1)}%), порог ${(args.minPassRate * 100).toFixed(1)}%`);

  if (rate < args.minPassRate) {
    fail(`pass rate ${rate.toFixed(3)} ниже порога ${args.minPassRate}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasets = await loadDatasets();
  const errors = validate(datasets);

  console.log(`Датасеты: ${datasets.length}/12 треков, кейсов: ${datasets.reduce((sum, item) => sum + (item.data.cases?.length ?? 0), 0)}`);
  if (errors.length > 0) {
    errors.forEach((message) => fail(message));
    process.exit(1);
  }
  console.log('Структура датасетов валидна; покрытие A–L подтверждено.');

  if (args.validateOnly) return;

  if (!args.apiUrl || !args.promptId || !args.versionId) {
    fail('для прогона нужны --api-url, --prompt-id и --version-id');
    process.exit(1);
  }
  await runEvals(datasets, args);
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
