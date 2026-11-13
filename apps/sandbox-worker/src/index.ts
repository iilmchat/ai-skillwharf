import Docker from 'dockerode';
import express, { type Request, type Response } from 'express';
import { Writable } from 'node:stream';
import {
  buildContainerConfig,
  buildExtraHosts,
  isCodeTooLong,
  parseExecutePayload,
  resolveEgressHosts,
  type SandboxContainerConfig,
  type SandboxExecutePayload,
} from './egress.js';
import {
  buildSecurityOpts,
  loadSeccompProfile,
  type LoadedSeccompProfile,
} from './seccomp.js';

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

/**
 * Feature flag: путь к seccomp-профилю внутри контейнера worker.
 * Пусто/не задано — прежнее поведение (профиль Docker по умолчанию).
 * В staging профиль обязателен, см. docker-compose.staging.yml.
 */
const seccompProfile = loadSeccompProfileOrExit();
const SANDBOX_SECURITY_OPTS = buildSecurityOpts(seccompProfile);

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
  if (isCodeTooLong(request.body)) {
    response.status(413).json({ message: 'Код превышает допустимый размер' });
    return;
  }

  let payload;
  try {
    payload = parseExecutePayload(request.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ message });
    return;
  }

  try {
    // Сеть: none без allowlist; bridge + iptables только для разрешённых FQDN.
    // Allowlist резолвится в worker-е ДО createContainer: ExtraHosts Docker
    // инжектит в /etc/hosts даже при read-only rootfs (prod-путь без DNS).
    const extraHosts = await resolveSandboxExtraHosts(payload);
    const containerConfig = buildContainerConfig(
      payload,
      {
        image: SANDBOX_IMAGE,
        securityOpts: SANDBOX_SECURITY_OPTS,
        memoryLimitBytes: SANDBOX_MEMORY_LIMIT_BYTES,
        nanoCpus: SANDBOX_NANO_CPUS,
      },
      extraHosts,
    );
    const result = await runInSandbox(containerConfig);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    response.status(500).json({ message });
  }
});

/**
 * Резолвит allowlist в IPv4 для `HostConfig.ExtraHosts`.
 *
 * Ошибка отдельного домена не фатальна: домен пропускается с логом, остальные
 * продолжают работать. IPv6 в ExtraHosts не поддерживается — такие домены
 * логируются и пропускаются (iptables-часть entrypoint-а всё равно разрешает
 * их IPv6-адреса, если стек присутствует).
 */
async function resolveSandboxExtraHosts(
  payload: SandboxExecutePayload,
): Promise<string[]> {
  if (payload.network !== 'bridge' || payload.egressAllowlist.length === 0) {
    return [];
  }

  const { resolved, unresolved, ipv6Only } = await resolveEgressHosts(
    payload.egressAllowlist,
  );

  if (unresolved.length > 0) {
    console.warn(
      `sandbox-worker: egress-домены не разрешились в IPv4, ExtraHosts не добавлены: ${unresolved.join(', ')}`,
    );
  }

  if (ipv6Only.length > 0) {
    console.warn(
      `sandbox-worker: ExtraHosts не поддерживает IPv6, домены пропущены: ${ipv6Only.join(', ')}`,
    );
  }

  return buildExtraHosts(resolved);
}

async function runInSandbox(
  config: SandboxContainerConfig,
): Promise<ExecuteResponse> {
  const container = await docker.createContainer(config);

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

function loadSeccompProfileOrExit(): LoadedSeccompProfile | undefined {
  try {
    return loadSeccompProfile(process.env.SANDBOX_SECCOMP_PROFILE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    process.exit(1);
  }
}

if (seccompProfile) {
  console.log(
    `sandbox-worker: seccomp profile enabled (${seccompProfile.path}, ${seccompProfile.ruleCount} rules)`,
  );
} else {
  console.log(
    'sandbox-worker: seccomp profile disabled (SANDBOX_SECCOMP_PROFILE is not set)',
  );
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`sandbox-worker listening on :${PORT}`);
});
