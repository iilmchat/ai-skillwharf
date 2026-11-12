import Docker from 'dockerode';
import express, { type Request, type Response } from 'express';
import { Writable } from 'node:stream';

/**
 * Worker — единственный сервис, у которого смонтирован Docker-сокет.
 * API не имеет доступа к Docker и общается с worker по HTTP внутри
 * compose-сети.
 */
const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'skillwharf-sandbox:latest';
const SANDBOX_TIMEOUT_MS = 10_000;
const SANDBOX_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
const SANDBOX_NANO_CPUS = 500_000_000;
const MAX_CODE_LENGTH = 256 * 1024;

/** Флаг в env, который не должен попадать внутрь sandbox-контейнера. */
const SANDBOX_NETWORK_FLAG = 'ALLOW_NETWORK';

interface ExecutePayload {
  code?: unknown;
  env?: unknown;
  network?: unknown;
}

interface ExecuteResponse {
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const docker = new Docker();
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request: Request, response: Response) => {
  response.json({ status: 'ok' });
});

app.post('/execute', async (request: Request, response: Response) => {
  const payload = request.body as ExecutePayload;

  if (typeof payload.code !== 'string' || payload.code.length === 0) {
    response.status(400).json({ message: 'Поле code обязательно' });
    return;
  }

  if (payload.code.length > MAX_CODE_LENGTH) {
    response.status(413).json({ message: 'Код превышает допустимый размер' });
    return;
  }

  const env = sanitizeEnv(payload.env);
  const network = payload.network === 'bridge' ? 'bridge' : 'none';

  try {
    const result = await runInSandbox(payload.code, env, network);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    response.status(500).json({ message });
  }
});

async function runInSandbox(
  code: string,
  env: Record<string, string>,
  network: 'bridge' | 'none',
): Promise<ExecuteResponse> {
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    Cmd: ['sh', '-c', code],
    User: '65534:65534',
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    Env: Object.entries(env)
      .filter(([key]) => key !== SANDBOX_NETWORK_FLAG)
      .map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      NetworkMode: network,
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
      console.warn(
        `sandbox-worker: не удалось остановить контейнер: ${String(error)}`,
      );
    });
  }, SANDBOX_TIMEOUT_MS);

  try {
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });
    docker.modem.demuxStream(stream, stdoutStream, stderrStream);
    await container.start();

    await new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });
  } finally {
    clearTimeout(timeout);
    await container.remove({ force: true }).catch((error: unknown) => {
      console.warn(
        `sandbox-worker: не удалось удалить контейнер: ${String(error)}`,
      );
    });
  }

  return { stdout, stderr, timedOut };
}

function sanitizeEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const env: Record<string, string> = {};

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      env[key] = item;
    }
  }

  return env;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`sandbox-worker listening on :${PORT}`);
});
