import { Injectable, Logger } from '@nestjs/common';
import Docker from 'dockerode';
import { Writable } from 'node:stream';

/**
 * Ограничения повторяют docker-compose.sandbox.yml: сеть выключена, корневая
 * файловая система только для чтения, сброшены capabilities, лимит 128 МБ и 0.5 CPU.
 */
const SANDBOX_IMAGE = 'alpine:3.20';
const SANDBOX_TIMEOUT_MS = 10_000;
const SANDBOX_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const SANDBOX_NANO_CPUS = 500_000_000;

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  private readonly docker = new Docker();

  /**
   * Выполняет shell-команду в одноразовом контейнере и возвращает stdout.
   * Контейнер удаляется в любом случае; при превышении таймаута kill.
   */
  async runCommand(code: string): Promise<string> {
    const container = await this.docker.createContainer({
      Image: SANDBOX_IMAGE,
      Cmd: ['sh', '-c', code],
      User: '65534:65534',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NetworkMode: 'none',
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
