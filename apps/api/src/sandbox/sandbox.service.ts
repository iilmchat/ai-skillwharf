import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
  planSandboxNetwork,
  SANDBOX_NETWORK_FLAG,
  type EgressPolicy,
} from './egress.js';

// Реэкспорт для существующих импортов (`llm.service.ts`, `chat.service.spec.ts`):
// флаг остаётся legacy-константой и только вычищается из env контейнера.
export { SANDBOX_NETWORK_FLAG } from './egress.js';

/**
 * Ограничения задаёт sandbox-worker: сеть по умолчанию выключена, корневая
 * файловая система только для чтения, сброшены capabilities, лимит 128 МБ
 * и 0.5 CPU.
 */
const SANDBOX_TIMEOUT_MS = 10_000;
const SANDBOX_WORKER_URL =
  process.env.SANDBOX_WORKER_URL ?? 'http://sandbox-worker:4000';

interface SandboxWorkerResponse {
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Опции запуска команды в песочнице. */
export interface SandboxRunOptions {
  /**
   * Политика egress. Без неё (или с пустым allowlist) контейнер запускается
   * без сети (`network: 'none'`), см. ADR 0004, п.3.
   */
  readonly egress?: EgressPolicy;
}

/**
 * Клиент sandbox-worker. У API нет Docker-сокета: он отправляет код по HTTP
 * доверенному worker'у, который запускает одноразовый контейнер.
 *
 * Сеть по умолчанию выключена (`network: 'none'`). Включает её только
 * `options.egress.allowlist`: worker поднимает bridge и разрешает egress лишь
 * к перечисленным FQDN. Legacy-флаги (`ALLOW_NETWORK` в env,
 * `SANDBOX_ALLOW_NETWORK` в окружении API) в контейнер не передаются и сеть
 * больше не включают.
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
    options: SandboxRunOptions = {},
  ): Promise<string> {
    // Валидация allowlist до HTTP-вызова: невалидный домен — ошибка запроса.
    const plan = planSandboxNetwork(options.egress);

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
          network: plan.network,
          egressAllowlist: plan.egressAllowlist,
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
