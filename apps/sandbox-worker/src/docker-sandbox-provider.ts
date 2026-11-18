import Docker from 'dockerode';
import { type Readable, Writable } from 'node:stream';
import { defaultEgressDnsResolver, validateEgressAllowlist } from './egress-proxy.js';
import {
  buildContainerConfig,
  buildExtraHosts,
  resolveEffectiveNetwork,
  resolveEgressHosts,
  type EgressDnsResolver,
  type SandboxContainerConfig,
} from './egress.js';
import type {
  ISandboxRuntimeProvider,
  SandboxExecutionRequest,
  SandboxResult,
} from './sandbox-runtime-provider.js';

/**
 * Дефолтный рантайм песочницы. Логика запуска контейнера перенесена из
 * `index.ts` без изменения поведения: при отсутствии allowlist контейнер
 * попрежнему запускается в сети `none`, от UID 65534, с теми же лимитами,
 * seccomp и таймаутом.
 */

/** Минимальный контракт dockerode, чтобы тестировать провайдер без демона. */
export interface DockerContainerLike {
  kill(): Promise<void>;
  attach(options: {
    stream: boolean;
    stdout: boolean;
    stderr: boolean;
  }): Promise<Readable>;
  start(): Promise<void>;
  remove(options: { force: boolean }): Promise<void>;
}

export interface DockerClientLike {
  createContainer(config: SandboxContainerConfig): Promise<DockerContainerLike>;
  modem: {
    demuxStream(stream: Readable, stdout: Writable, stderr: Writable): void;
  };
  ping(): Promise<unknown>;
}

export interface DockerSandboxProviderOptions {
  readonly image: string;
  readonly securityOpts: readonly string[];
  readonly memoryLimitBytes: number;
  readonly nanoCpus: number;
  readonly timeoutMs: number;
  /** DI: подставляется в тестах; по умолчанию — реальный dockerode. */
  readonly docker?: DockerClientLike;
  /** DI: резолвер allowlist (SEC-25.3). */
  readonly egressResolver?: EgressDnsResolver;
  /**
   * Адрес встроенного SNI/Host-прокси, доступный изнутри контейнера.
   * Пусто — инъекция proxy-env не выполняется (прежнее поведение).
   */
  readonly egressProxyUrl?: string;
}

/** Резолвит allowlist в IPv4 для `HostConfig.ExtraHosts` (как раньше). */
async function resolveSandboxExtraHosts(
  request: SandboxExecutionRequest,
  resolver: EgressDnsResolver,
): Promise<string[]> {
  if (request.network !== 'bridge' || request.egressAllowlist.length === 0) {
    return [];
  }

  const { resolved, unresolved, ipv6Only } = await resolveEgressHosts(
    request.egressAllowlist,
    resolver,
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

export class DockerSandboxProvider implements ISandboxRuntimeProvider {
  private readonly docker: DockerClientLike;
  private readonly egressResolver: EgressDnsResolver;
  private readonly egressProxyUrl: string;

  constructor(private readonly options: DockerSandboxProviderOptions) {
    // dockerode обращается к сокету демона; приведение через unknown не
    // подменяется `any` и не меняет поведение вызовов.
    this.docker = options.docker ?? (new Docker() as unknown as DockerClientLike);
    this.egressResolver = options.egressResolver ?? defaultEgressDnsResolver;
    this.egressProxyUrl = options.egressProxyUrl?.trim() ?? '';
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxResult> {
    const effective = resolveEffectiveNetwork(request);

    // SEC-25.3: при наличии allowlist проверяем домены ДО запуска контейнера.
    // DNS rebinding/SSRF (169.254.169.254, 127.0.0.1) — fail closed.
    if (effective.network === 'bridge') {
      await validateEgressAllowlist(effective.egressAllowlist, this.egressResolver);
    }

    const extraHosts = await resolveSandboxExtraHosts(request, this.egressResolver);
    const containerConfig = buildContainerConfig(
      request,
      {
        image: this.options.image,
        securityOpts: this.options.securityOpts,
        memoryLimitBytes: this.options.memoryLimitBytes,
        nanoCpus: this.options.nanoCpus,
      },
      extraHosts,
    );
    const config = this.withProxyEnv(containerConfig, effective.network);

    return this.runInSandbox(config);
  }

  /**
   * Включает маршрутизацию через встроенный прокси только для задач с
   * egressAllowlist и только когда явно задан адрес прокси. Без allowlist
   * конфиг не меняется — сеть остаётся `none`.
   */
  private withProxyEnv(
    config: SandboxContainerConfig,
    network: 'none' | 'bridge',
  ): SandboxContainerConfig {
    if (network !== 'bridge' || !this.egressProxyUrl) {
      return config;
    }

    return {
      ...config,
      Env: [
        ...config.Env,
        `HTTP_PROXY=${this.egressProxyUrl}`,
        `HTTPS_PROXY=${this.egressProxyUrl}`,
        `http_proxy=${this.egressProxyUrl}`,
        `https_proxy=${this.egressProxyUrl}`,
        'NO_PROXY=127.0.0.1,localhost,127.0.0.11,::1',
      ],
    };
  }

  /** Запуск контейнера — дословно бывший `runInSandbox` из `index.ts`. */
  private async runInSandbox(config: SandboxContainerConfig): Promise<SandboxResult> {
    const container = await this.docker.createContainer(config);

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
    }, this.options.timeoutMs);

    try {
      const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });
      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);
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
}
