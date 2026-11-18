import express, { type Request, type Response } from 'express';
import { isCodeTooLong, parseExecutePayload } from './egress.js';
import {
  createSandboxRuntimeProvider,
  SANDBOX_MEMORY_LIMIT_BYTES,
  SANDBOX_NANO_CPUS,
  SANDBOX_TIMEOUT_MS,
} from './provider-factory.js';
import type {
  ISandboxRuntimeProvider,
  SandboxResult,
} from './sandbox-runtime-provider.js';
import {
  buildSecurityOpts,
  loadSeccompProfile,
  type LoadedSeccompProfile,
} from './seccomp.js';

/**
 * Worker — единственный сервис, у которого смонтирован Docker-сокет.
 * API не имеет доступа к Docker и общается с worker по HTTP внутри
 * compose-сети.
 *
 * Рантайм выбирается один раз при старте: по умолчанию (и при
 * `SANDBOX_RUNTIME=docker`) — Docker, поведение прежнее. Явный
 * `SANDBOX_RUNTIME=firecracker` включает microVM-провайдер.
 */
const PORT = Number.parseInt(process.env.PORT ?? '4000', 10);

function loadSeccompProfileOrExit(): LoadedSeccompProfile | undefined {
  try {
    return loadSeccompProfile(process.env.SANDBOX_SECCOMP_PROFILE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    process.exit(1);
  }
}

const seccompProfile = loadSeccompProfileOrExit();
const SANDBOX_SECURITY_OPTS = buildSecurityOpts(seccompProfile);

function createProviderOrExit(): ISandboxRuntimeProvider {
  try {
    return createSandboxRuntimeProvider({ securityOpts: SANDBOX_SECURITY_OPTS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    process.exit(1);
  }
}

const provider = createProviderOrExit();
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
    const result: SandboxResult = await provider.execute({
      ...payload,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      memoryLimitBytes: SANDBOX_MEMORY_LIMIT_BYTES,
      nanoCpus: SANDBOX_NANO_CPUS,
    });
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sandbox-worker: ${message}`);
    response.status(500).json({ message });
  }
});

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
