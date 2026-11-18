import {
  DockerSandboxProvider,
  type DockerClientLike,
} from './docker-sandbox-provider.js';
import type { EgressDnsResolver } from './egress.js';
import { FirecrackerSandboxProvider } from './firecracker-sandbox-provider.js';
import type { FirecrackerProviderDependencies } from './firecracker-sandbox-provider.js';
import {
  loadFirecrackerConfig,
  loadSandboxRuntimeName,
  type ISandboxRuntimeProvider,
} from './sandbox-runtime-provider.js';

/**
 * Выбор рантайма по env. Docker — дефолт: при отсутствии `SANDBOX_RUNTIME`
 * или `SANDBOX_RUNTIME=docker` поведение идентично прежнему. Firecracker
 * создаётся только при явном выборе иfail closed без `/dev/kvm`.
 */

export const DEFAULT_SANDBOX_IMAGE = 'skillwharf-sandbox:latest';
export const SANDBOX_TIMEOUT_MS = 10_000;
export const SANDBOX_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const SANDBOX_NANO_CPUS = 500_000_000;

export interface SandboxRuntimeFactoryOptions {
  /**env подставляется в тестах; по умолчанию — процессный. */
  readonly env?: NodeJS.ProcessEnv;
  readonly securityOpts?: readonly string[];
  readonly docker?: DockerClientLike;
  readonly egressResolver?: EgressDnsResolver;
  readonly firecrackerDependencies?: FirecrackerProviderDependencies;
}

export function createSandboxRuntimeProvider(
  options: SandboxRuntimeFactoryOptions = {},
): ISandboxRuntimeProvider {
  const env = options.env ?? process.env;
  const runtime = loadSandboxRuntimeName(env);

  if (runtime === 'firecracker') {
    return new FirecrackerSandboxProvider(
      loadFirecrackerConfig(env),
      options.firecrackerDependencies,
    );
  }

  return new DockerSandboxProvider({
    image: env.SANDBOX_IMAGE?.trim() || DEFAULT_SANDBOX_IMAGE,
    securityOpts: options.securityOpts ?? ['no-new-privileges:true'],
    memoryLimitBytes: SANDBOX_MEMORY_LIMIT_BYTES,
    nanoCpus: SANDBOX_NANO_CPUS,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    docker: options.docker,
    egressResolver: options.egressResolver,
    egressProxyUrl: env.SANDBOX_EGRESS_PROXY_URL?.trim() ?? '',
  });
}
