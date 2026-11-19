import { isAxiosError } from 'axios';
import { z } from 'zod';
import i18n from '../i18n';
import { api } from './api';

export interface PromptTemplate {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  activeVersion?: string | number;
  currentVersion?: string | number;
  version?: string | number;
  versions?: PromptVersion[];
  updatedAt?: string;
}

export interface PromptVersion {
  id: string;
  templateId?: string;
  version?: string | number;
  content: string;
  environment?: string;
  createdBy?: string;
  createdAt?: string;
}

/**
 * Контракт A/B-экспериментов промптов (WEB-28.1).
 *
 * API Sprint 28 может отдавать метрики как `metrics: { A, B }`, так и
 * `variantAMetrics`/`variantBMetrics`, а идентификаторы версий — плоскими
 * полями или внутри `variantA`/`variantB`. Нормализация происходит внутри
 * Zod-схемы: наружу всегда уходит один и тот же тип.
 */
const numericMetricSchema = z.union([
  z.number().nonnegative(),
  z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number),
]);

const percentSchema = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number),
]);

export const promptExperimentStatsSchema = z.object({
  calls: numericMetricSchema,
  avgLatencyMs: numericMetricSchema,
  avgCost: numericMetricSchema,
});

const promptExperimentStatsInputSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  return {
    calls: value.calls ?? value.requests ?? value.count,
    avgLatencyMs:
      value.avgLatencyMs ?? value.avgLatency ?? value.averageLatencyMs,
    avgCost: value.avgCost ?? value.avgCostRub ?? value.averageCost,
  };
}, promptExperimentStatsSchema);

const promptExperimentBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z
    .enum(['running', 'active', 'stopped', 'completed'])
    .default('running'),
  variantAVersionId: z.string().min(1),
  variantBVersionId: z.string().min(1),
  // API хранит долю 0–100; UI при создании ограничивает её 10–90.
  trafficSplitB: percentSchema.refine(
    (value) => value >= 0 && value <= 100,
    'доля трафика B должна быть от 0 до 100 процентов',
  ),
  createdAt: z.string().min(1),
  stoppedAt: z.string().nullable().optional(),
  winnerVersionId: z.string().nullable().optional(),
  promotedVersionId: z.string().optional(),
  metrics: z
    .object({
      A: promptExperimentStatsInputSchema.optional(),
      B: promptExperimentStatsInputSchema.optional(),
    })
    .optional(),
});

export const promptExperimentSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  const variantA = isRecord(value.variantA) ? value.variantA : undefined;
  const variantB = isRecord(value.variantB) ? value.variantB : undefined;
  const metrics = isRecord(value.metrics) ? value.metrics : undefined;

  return {
    ...value,
    variantAVersionId:
      value.variantAVersionId ?? variantA?.versionId ?? variantA?.version,
    variantBVersionId:
      value.variantBVersionId ?? variantB?.versionId ?? variantB?.version,
    trafficSplitB:
      value.trafficSplitB ?? value.trafficSplit ?? value.trafficSplitPercent,
    metrics: {
      A:
        value.variantAMetrics ??
        metrics?.A ??
        metrics?.a ??
        variantA?.stats ??
        variantA?.metrics,
      B:
        value.variantBMetrics ??
        metrics?.B ??
        metrics?.b ??
        variantB?.stats ??
        variantB?.metrics,
    },
  };
}, promptExperimentBaseSchema);

export type PromptExperiment = z.infer<typeof promptExperimentSchema>;

export const promptExperimentListSchema = z.preprocess(
  (value) =>
    isRecord(value)
      ? (value.items ?? value.experiments ?? value.data ?? value)
      : value,
  z.array(promptExperimentSchema),
);

export const createPromptExperimentSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    variantAVersionId: z.string().min(1),
    variantBVersionId: z.string().min(1),
    trafficSplitB: z.number().int().min(10).max(90),
  })
  .refine((value) => value.variantAVersionId !== value.variantBVersionId, {
    message: 'варианты должны использовать разные версии',
    path: ['variantBVersionId'],
  });

export type CreatePromptExperimentInput = z.infer<
  typeof createPromptExperimentSchema
>;

/** Stop может вернуть как обновлённый эксперимент, так и короткий статус. */
export const promptExperimentStopResponseSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  promotedVersionId: z.string().optional(),
  success: z.boolean().optional(),
});

export type PromptExperimentStopResult = z.infer<
  typeof promptExperimentStopResponseSchema
>;

export function isPromptExperimentActive(experiment: PromptExperiment): boolean {
  return experiment.status === 'running' || experiment.status === 'active';
}

/**
 * Контракт автоматической оценки промптов (Sprint 29, LLM Evals).
 *
 * `GET /prompts/:id/evals` отдаёт историю прогонов, `POST .../evals/run`
 * запускает прогон для версии с необязательным фильтром по треку A–L.
 */
export const PROMPT_EVAL_TRACK_IDS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
] as const;

export type PromptEvalTrackId = (typeof PROMPT_EVAL_TRACK_IDS)[number];

const promptEvalCaseResultBaseSchema = z.object({
  caseId: z.string().min(1),
  trackId: z.enum(PROMPT_EVAL_TRACK_IDS),
  title: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  reasoning: z.string(),
});

/**
 * API Sprint 29 хранит вердикт судьи в `verdict: { passed, score, reasoning }`
 * и не передаёт `title`; клиентская схема приводит его к плоской форме,
 * которую показывает панель. Плоский формат из задания тоже принимается.
 */
export const promptEvalCaseResultSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  const verdict = isRecord(value.verdict) ? value.verdict : undefined;

  return {
    ...value,
    title: value.title ?? value.caseId,
    passed: value.passed ?? verdict?.passed,
    score: value.score ?? verdict?.score,
    reasoning: value.reasoning ?? verdict?.reasoning,
  };
}, promptEvalCaseResultBaseSchema);

export type PromptEvalCaseResult = z.infer<typeof promptEvalCaseResultSchema>;

export const promptEvalRunSchema = z.object({
  id: z.string().min(1),
  promptId: z.string().min(1),
  versionId: z.string().min(1),
  trackFilter: z.string().nullable().optional(),
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  // API отдаёт долю 0..1, UI показывает проценты; плоский 0..100 тоже принимаем.
  passRate: z
    .number()
    .min(0)
    .max(100)
    .transform((value) => (value <= 1 ? value * 100 : value)),
  avgScore: z.number().min(0).max(100),
  status: z.enum(['running', 'passed', 'failed']),
  results: z.array(promptEvalCaseResultSchema).optional(),
  createdAt: z.string().min(1),
});

export type PromptEvalRun = z.infer<typeof promptEvalRunSchema>;

export const promptEvalRunListSchema = z.preprocess(
  (value) =>
    isRecord(value)
      ? (value.items ?? value.runs ?? value.data ?? value)
      : value,
  z.array(promptEvalRunSchema),
);

export const runPromptEvalSchema = z.object({
  versionId: z.string().min(1),
  trackId: z.enum(PROMPT_EVAL_TRACK_IDS).optional(),
});

export type RunPromptEvalInput = z.infer<typeof runPromptEvalSchema>;

export const LLM_PROVIDER_TYPES = [
  'OpenAI',
  'YandexGPT',
  'GigaChat',
  'Ollama',
] as const;

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

/**
 * Типы задач LLM Router. Контракт совпадает с `LLM_TASK_TYPES` API:
 * fallback-цепочка строится только внутри одного типа задачи. В API
 * reasoning-задачи называются `analysis`, embedding-маршруты — `embeddings`;
 * значения `reasoning`/`embedding` DTO отклоняет как 400.
 */
export const LLM_TASK_TYPES = ['chat', 'analysis', 'embeddings'] as const;

export type LlmTaskType = (typeof LLM_TASK_TYPES)[number];

/**
 * Маршрут LLM Router (`GET /api/v1/admin/llm-routes`).
 *
 * Новые поля Sprint 16 (`taskType`, `dailyCostLimit`) опциональны для
 * совместимости со старым API: если их нет, маршрут считается `chat`-маршрутом
 * без дневного лимита. Ответ валидируется Zod, чтобы UI не показывал данные
 * неверного типа.
 */
export const llmRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  modelName: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
  baseUrl: z.string().optional(),
  baseURL: z.string().optional(),
  apiKeyEnvVar: z.string().nullable().optional(),
  priority: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  taskType: z.enum(LLM_TASK_TYPES).optional(),
  dailyCostLimit: z.number().nonnegative().nullable().optional(),
});

export type LlmRoute = z.infer<typeof llmRouteSchema>;

export interface CreateLlmRouteInput {
  name: string;
  modelName: string;
  providerType: LlmProviderType;
  baseUrl: string;
  priority: number;
  taskType: LlmTaskType;
  dailyCostLimit?: number;
}

/**
 * PATCH-контракт: форма редактирования присылает полный набор полей.
 * Пустой `dailyCostLimit` означает «не менять лимит»: контракт PATCH не
 * описывает `null`, поэтому снять лимит через Control Plane пока нельзя.
 */
export type UpdateLlmRouteInput = CreateLlmRouteInput;

export interface AuditEntry {
  id: string;
  action: string;
  actor?: string;
  actorEmail?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  target?: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  createdAt?: string;
}

export interface ImportedSkill {
  id: string;
  name: string;
  version: string;
  warning?: string;
  danger?: string;
}

export const adminQueryKeys = {
  prompts: ['admin', 'prompts'] as const,
  promptVersions: (promptId: string) =>
    ['admin', 'prompts', promptId, 'versions'] as const,
  promptExperiments: (promptId: string) =>
    ['admin', 'prompts', promptId, 'experiments'] as const,
  promptEvals: (promptId: string) =>
    ['admin', 'prompts', promptId, 'evals'] as const,
  llmRoutes: ['admin', 'llm-routes'] as const,
  audit: ['admin', 'audit'] as const,
};

interface MessagePayload {
  message: string | string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessagePayload(value: unknown): value is MessagePayload {
  if (!isRecord(value) || !('message' in value)) {
    return false;
  }

  const { message } = value;

  return (
    typeof message === 'string' ||
    (Array.isArray(message) &&
      message.every((item): item is string => typeof item === 'string'))
  );
}

function translateServerMessage(message: string): string {
  return message.startsWith('errors.') && i18n.exists(message)
    ? i18n.t(message)
    : message;
}

function formatServerMessage(message: string | string[]): string {
  return Array.isArray(message)
    ? message.map(translateServerMessage).join('; ')
    : translateServerMessage(message);
}

/**
 * Бэкенд может вернуть как массив, так и обёртку `{ items: [...] }`.
 * Для админских списков это допустимо, поэтому принимаем оба варианта.
 */
function unwrapList<T>(value: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (isRecord(value)) {
    for (const key of keys) {
      const list = value[key];

      if (Array.isArray(list)) {
        return list as T[];
      }
    }
  }

  return [];
}

export async function fetchPrompts(): Promise<PromptTemplate[]> {
  const { data } = await api.get<unknown>('/prompts');

  return unwrapList<PromptTemplate>(data, ['prompts', 'items', 'data']);
}

export async function fetchPromptVersions(
  promptId: string,
): Promise<PromptVersion[]> {
  const encodedId = encodeURIComponent(promptId);

  try {
    const { data } = await api.get<unknown>(`/prompts/${encodedId}/versions`);

    return unwrapList<PromptVersion>(data, ['versions', 'items', 'data']);
  } catch (error) {
    // Некоторые реализации отдают версии внутри карточки шаблона.
    if (isAxiosError(error) && error.response?.status === 404) {
      const { data } = await api.get<unknown>(`/prompts/${encodedId}`);

      if (isRecord(data)) {
        const versions =
          data.versions ??
          (isRecord(data.prompt) ? data.prompt.versions : undefined);

        if (Array.isArray(versions)) {
          return versions as PromptVersion[];
        }
      }
    }

    throw error;
  }
}

export async function createPromptVersion(
  promptId: string,
  content: string,
): Promise<PromptVersion> {
  const { data } = await api.post<PromptVersion>(
    `/prompts/${encodeURIComponent(promptId)}/versions`,
    { content },
  );

  return data;
}

/** GET /api/v1/prompts/:id/experiments. */
export async function fetchPromptExperiments(
  promptId: string,
): Promise<PromptExperiment[]> {
  const { data } = await api.get<unknown>(
    `/prompts/${encodeURIComponent(promptId)}/experiments`,
  );

  return promptExperimentListSchema.parse(data);
}

/** POST /api/v1/prompts/:id/experiments. */
export async function createPromptExperiment(
  promptId: string,
  payload: CreatePromptExperimentInput,
): Promise<PromptExperiment> {
  const input = createPromptExperimentSchema.parse(payload);
  const { data } = await api.post<unknown>(
    `/prompts/${encodeURIComponent(promptId)}/experiments`,
    input,
  );

  return promptExperimentSchema.parse(data);
}

/** POST /api/v1/prompts/experiments/:expId/stop. */
export async function stopPromptExperiment(
  expId: string,
  promoteVersionId?: string,
): Promise<PromptExperimentStopResult> {
  const { data } = await api.post<unknown>(
    `/prompts/experiments/${encodeURIComponent(expId)}/stop`,
    promoteVersionId === undefined ? {} : { promoteVersionId },
  );

  // 204 No Content — допустимый ответ: обновление списка сделает UI сам.
  if (data === undefined || data === null || data === '') {
    return {};
  }

  return promptExperimentStopResponseSchema.parse(data);
}

/** GET /api/v1/prompts/:id/evals — история прогонов Evals. */
export async function fetchPromptEvals(
  promptId: string,
): Promise<PromptEvalRun[]> {
  const { data } = await api.get<unknown>(
    `/prompts/${encodeURIComponent(promptId)}/evals`,
  );

  return promptEvalRunListSchema.parse(data);
}

/** POST /api/v1/prompts/:id/evals/run — запуск прогона для версии. */
export async function runPromptEval(
  promptId: string,
  input: RunPromptEvalInput,
): Promise<PromptEvalRun> {
  const payload = runPromptEvalSchema.parse(input);
  const { data } = await api.post<unknown>(
    `/prompts/${encodeURIComponent(promptId)}/evals/run`,
    payload,
  );

  return promptEvalRunSchema.parse(data);
}

export async function fetchLlmRoutes(): Promise<LlmRoute[]> {
  const { data } = await api.get<unknown>('/admin/llm-routes');
  const items = unwrapList<unknown>(data, [
    'routes',
    'rules',
    'items',
    'data',
  ]);

  return items.map((item) => llmRouteSchema.parse(item));
}

export async function createLlmRoute(
  input: CreateLlmRouteInput,
): Promise<LlmRoute> {
  const { data } = await api.post<unknown>('/admin/llm-routes', input);

  return llmRouteSchema.parse(data);
}

export async function updateLlmRoute(
  id: string,
  input: UpdateLlmRouteInput,
): Promise<LlmRoute> {
  const { data } = await api.patch<unknown>(
    `/admin/llm-routes/${encodeURIComponent(id)}`,
    input,
  );

  return llmRouteSchema.parse(data);
}

export async function fetchAudit(): Promise<AuditEntry[]> {
  const { data } = await api.get<unknown>('/admin/audit');

  return unwrapList<AuditEntry>(data, ['entries', 'events', 'items', 'data']);
}

/** Загружает ZIP-архив OpenClaw в админский эндпоинт импорта. */
export async function importSkillArchive(file: File): Promise<ImportedSkill> {
  const formData = new FormData();
  formData.append('file', file);

  const { data } = await api.postForm<ImportedSkill>(
    '/admin/skills/import',
    formData,
  );

  return data;
}

export function getAdminErrorMessage(
  error: unknown,
  fallbackKey: string,
): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('admin.errors.network');
    }

    const { status } = error.response;

    if (status === 401) {
      return i18n.t('admin.errors.sessionExpired');
    }

    if (status === 403) {
      return i18n.t('admin.errors.adminOnly');
    }

    if (status === 404 || status === 501) {
      return i18n.t('admin.errors.notAvailable');
    }

    const data: unknown = error.response.data;

    // ApiErrorBody несёт machine-readable код и человекочитаемый message:
    // код имеет приоритет, иначе errors.eval_gate_failed останется сырым.
    if (isRecord(data) && typeof data.code === 'string' && i18n.exists(data.code)) {
      return i18n.t(data.code);
    }

    if (isMessagePayload(data)) {
      return formatServerMessage(data.message);
    }

    return i18n.t(fallbackKey);
  }

  if (error instanceof Error && error.message !== '') {
    return error.message;
  }

  return i18n.t(fallbackKey);
}

export function formatAdminDate(
  value: string | undefined,
  language: string,
): string {
  if (value === undefined || value === '') {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function getPromptVersionLabel(prompt: PromptTemplate): string {
  const version =
    prompt.versions?.[0]?.version ??
    prompt.activeVersion ??
    prompt.currentVersion ??
    prompt.version;

  return version === undefined ? '—' : String(version);
}

export function getLlmRouteModel(route: LlmRoute): string {
  return route.modelName ?? route.model ?? '—';
}

export function getLlmRouteProvider(route: LlmRoute): LlmProviderType {
  return route.providerType ?? 'OpenAI';
}

export function getLlmRouteTaskType(route: LlmRoute): LlmTaskType {
  return route.taskType ?? 'chat';
}

export function getLlmRouteBaseUrl(route: LlmRoute): string {
  return route.baseUrl ?? route.baseURL ?? '—';
}

export function getAuditActor(entry: AuditEntry): string {
  return entry.actor ?? entry.actorEmail ?? entry.userId ?? '—';
}

export function getAuditTarget(entry: AuditEntry): string {
  if (entry.target !== undefined && entry.target !== '') {
    return entry.target;
  }

  const id = entry.entityId ?? entry.targetId ?? '';
  const type = entry.entityType ?? entry.targetType ?? '';

  if (type !== '' && id !== '') {
    return `${type}: ${id}`;
  }

  return id !== '' ? id : '—';
}
