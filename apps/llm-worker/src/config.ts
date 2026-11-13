/** Настройки llm-worker из окружения. */
export interface WorkerConfig {
  port: number;
  internalApiUrl: string | null;
  internalToken: string | null;
  requestTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const internalApiUrl = env.INTERNAL_API_URL?.trim() ?? '';
  const internalToken = env.INTERNAL_API_TOKEN?.trim() ?? '';

  return {
    port: positiveInt(env.LLM_WORKER_PORT, 4100),
    internalApiUrl: internalApiUrl === '' ? null : internalApiUrl,
    internalToken: internalToken === '' ? null : internalToken,
    requestTimeoutMs: positiveInt(env.LLM_WORKER_REQUEST_TIMEOUT_MS, 30_000),
  };
}
