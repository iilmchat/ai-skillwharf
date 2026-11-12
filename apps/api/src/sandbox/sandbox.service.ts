import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { Writable } from 'node:stream';

/**
 * Ограничения повторяют docker-compose.sandbox.yml: сеть по умолчанию выключена,
 * корневая файловая система только для чтения, сброшены capabilities,
 * лимит 128 МБ и 0.5 CPU.
 */
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'skillwharf-sandbox:latest';
const SANDBOX_TIMEOUT_MS = 10_000;
const SANDBOX_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const SANDBOX_NANO_CPUS = 500_000_000;

/** Флаг в `env`, разрешающий контейнеру доступ в сеть. */
export const SANDBOX_NETWORK_FLAG = 'ALLOW_NETWORK';

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

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  private readonly docker = new Docker();

  /**
   * Выполняет shell-команду в одноразовом контейнере и возвращает stdout.
   * Контейнер удаляется в любом случае; при превышении таймаута kill.
   *
   * `env` передаётся в контейнер как переменные окружения (например, ключи
   * внешних API для навыков). Значения видны в `docker inspect` — передавайте
   * только те секреты, которые нужны выполняемому коду.
   */
  async runCommand(
    code: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const container = await this.docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: ['sh', '-c', code],
      User: '65534:65534',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      // Сам флаг — управляющий, внутрь контейнера его не передаём.
      Env: Object.entries(env)
        .filter(([key]) => key !== SANDBOX_NETWORK_FLAG)
        .map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        NetworkMode: resolveNetworkMode(env),
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Tmpfs: { '/tmp': '' },
        Memory: SANDBOX_MEMORY_LIMIT_BYTES,
        NanoCpus: SANDBOX_NANO_CPUS,
      },
    });

    let stdout = '';
    let stderr = '';
    const stdoutStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });
    const stderrStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      container.kill().catch((error: unknown) => {
        this.logger.warn(`Не удалось остановить sandbox-контейнер: ${String(error)}`);
      });
    }, SANDBOX_TIMEOUT_MS);

    try {
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
      await container.start();

      await new Promise<void>((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
    } finally {
      clearTimeout(timeout);
      await container.remove({ force: true }).catch((error: unknown) => {
        this.logger.warn(`Не удалось удалить sandbox-контейнер: ${String(error)}`);
      });
    }

    if (timedOut) {
      throw new Error(`Команда превысила лимит ${SANDBOX_TIMEOUT_MS} мс и была остановлена`);
    }
    if (stderr.trim()) {
      this.logger.debug(`stderr sandbox: ${stderr.trim()}`);
    }

    return stdout;
  }
}
