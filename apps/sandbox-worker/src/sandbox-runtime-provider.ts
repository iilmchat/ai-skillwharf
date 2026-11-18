import { z } from 'zod';
import type { SandboxExecutePayload } from './egress.js';

/**
 * Интерфейс рантайма песочницы (ADR 0002, Sprint 25 / INFRA-25.1).
 *
 * Docker остаётся основным и дефолтным провайдером. Firecracker — опция для
 * bare-metal/KVM-узлов Enterprise-клиентов и activates только явным
 * `SANDBOX_RUNTIME=firecracker`.
 */

/** Поддерживаемые рантаймы. Порядок важен для сообщений об ошибках. */
export const SANDBOX_RUNTIMES = ['docker', 'firecracker'] as const;

export const sandboxRuntimeSchema = z.enum(SANDBOX_RUNTIMES);

export type SandboxRuntimeName = z.infer<typeof sandboxRuntimeSchema>;

/**
 * Запрос на выполнение: валидированный payload `POST /execute` плюс лимиты
 * воркера. Провайдер не читает `process.env` во время выполнения — вся
 * конфигурация инжектируется в конструктор.
 */
export interface SandboxExecutionRequest extends SandboxExecutePayload {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly nanoCpus: number;
}

/** Результат выполнения (ранее — `ExecuteResponse` в `index.ts`). */
export interface SandboxResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Контракт провайдера рантайма. DI — только через конструктор. */
export interface ISandboxRuntimeProvider {
  execute(request: SandboxExecutionRequest): Promise<SandboxResult>;
  healthCheck(): Promise<boolean>;
}

/**
 * Конфигурация microVM Firecracker. Все поля валидируются Zod: невалидная
 * конфигурация — ошибка старта (fail closed), а не молчаливый дефолт.
 */
export const firecrackerConfigSchema = z.object({
  bin: z.string().min(1),
  kernelImage: z.string().min(1),
  rootfsImage: z.string().min(1),
  vcpuCount: z.number().int().positive().max(64),
  memSizeMib: z.number().int().positive().max(16_384),
  apiSocketDir: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000),
});

export type FirecrackerConfig = z.infer<typeof firecrackerConfigSchema>;

/**
 * Читает положительное целое из env через Zod. Пусто/не задано — fallback;
 * нечисло, ноль и отрицание — ошибка валидации (fail closed).
 */
function positiveIntFromEnv(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return fallback;
  }

  const parsed = z.coerce.number().int().positive().safeParse(trimmed);

  if (!parsed.success) {
    throw new Error(`${name} должен быть положительным целым: ${trimmed}`);
  }

  return parsed.data;
}

/**
 * Собирает конфигурацию Firecracker из env по требованию — только когда
 * выбран `SANDBOX_RUNTIME=firecracker`. Отсутствие Kernel/RootFS не
 * подменяется дефолтом: Zod отклонит пустые строки.
 */
export function loadFirecrackerConfig(
  env: NodeJS.ProcessEnv = process.env,
): FirecrackerConfig {
  return firecrackerConfigSchema.parse({
    bin: env.FIRECRACKER_BIN?.trim() || '/usr/bin/firecracker',
    kernelImage: env.FIRECRACKER_KERNEL_IMAGE?.trim() ?? '',
    rootfsImage: env.FIRECRACKER_ROOTFS_IMAGE?.trim() ?? '',
    vcpuCount: positiveIntFromEnv(env.FIRECRACKER_VCPU_COUNT, 1, 'FIRECRACKER_VCPU_COUNT'),
    memSizeMib: positiveIntFromEnv(env.FIRECRACKER_MEM_SIZE_MIB, 128, 'FIRECRACKER_MEM_SIZE_MIB'),
    apiSocketDir: env.FIRECRACKER_API_SOCKET_DIR?.trim() || '/tmp',
    timeoutMs: positiveIntFromEnv(env.FIRECRACKER_TIMEOUT_MS, 10_000, 'FIRECRACKER_TIMEOUT_MS'),
  });
}

/**
 * Читает и валидирует имя рантайма. Отсутствие переменной и пустая строка —
 * `docker` (прежнее поведение). Неизвестное значение — ошибка: мы не будем
 * молча запускать контейнеры через неподдерживаемый рантайм.
 */
export function loadSandboxRuntimeName(
  env: NodeJS.ProcessEnv = process.env,
): SandboxRuntimeName {
  const raw = env.SANDBOX_RUNTIME?.trim();

  if (!raw) {
    return 'docker';
  }

  const parsed = sandboxRuntimeSchema.safeParse(raw.toLowerCase());

  if (!parsed.success) {
    throw new Error(
      `SANDBOX_RUNTIME: неизвестный рантайм ${raw}; поддерживаются: ${SANDBOX_RUNTIMES.join(', ')}`,
    );
  }

  return parsed.data;
}
