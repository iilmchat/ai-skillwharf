import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

/**
 * Ограничения задаёт sandbox-worker: сеть по умолчанию выключена, корневая
 * файловая система только для чтения, сброшены capabilities, лимит 128 МБ
 * и 0.5 CPU.
 */
const SANDBOX_TIMEOUT_MS = 10_000;
const SANDBOX_WORKER_URL =
  process.env.SANDBOX_WORKER_URL ?? 'http://sandbox-worker:4000';

/** Флаг в `env`, разрешающий контейнеру доступ в сеть. */
export const SANDBOX_NETWORK_FLAG = 'ALLOW_NETWORK';

interface SandboxWorkerResponse {
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Сеть включается по флагу `ALLOW_NETWORK=true` (запрос навыка) или глобально
 * через `SANDBOX_ALLOW_NETWORK=true` (локальная разработка). По умолчанию
 * контейнер запускается с `none`: это защищает от exfiltration секретов.
 */
export function resolveNetworkMode(
  env: Record<string, string>,
): 'bridge' | 'none' {
  const requested = env[SANDBOX_NETWORK_FLAG] === 'true';
  const allowedGlobally = process.env.SANDBOX_ALLOW_NETWORK === 'true';

  return requested || allowedGlobally ? 'bridge' : 'none';
}

/**
 * Клиент sandbox-worker. У API нет Docker-сокета: он отправляет код по HTTP
 * доверенному worker'у, который запускает одноразовый контейнер.
 */
@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);

  /**
   * Выполняет shell-команду в одноразовом контейнере и возвращает stdout.
   *
   * `env` передаётся worker'у как переменные окружения контейнера (например,
   * ключи внешних API для навыков). Передавайте только те секреты, которые
   * нужны выполняемому коду.
   */
  async runCommand(
    code: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const safeEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => key !== SANDBOX_NETWORK_FLAG),
    );

    let result: SandboxWorkerResponse;

    try {
      const response = await axios.post<SandboxWorkerResponse>(
        `${SANDBOX_WORKER_URL}/execute`,
        {
          code,
          env: safeEnv,
          network: resolveNetworkMode(env),
        },
        { timeout: SANDBOX_TIMEOUT_MS + 5_000 },
      );

      result = response.data;
    } catch (error) {
      const detail = axios.isAxiosError(error)
        ? (extractWorkerError(error.response?.data) ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);

      throw new Error(`sandbox-worker: ${detail}`);
    }

    if (result.timedOut) {
      throw new Error(
        `Команда превысила лимит ${SANDBOX_TIMEOUT_MS} мс и была остановлена`,
      );
    }

    if (result.stderr.trim()) {
      this.logger.debug(`stderr sandbox: ${result.stderr.trim()}`);
    }

    return result.stdout;
  }
}

function extractWorkerError(data: unknown): string | null {
  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
  ) {
    return data.message;
  }

  return null;
}
