import { PassThrough } from 'node:stream';
import {
  DockerSandboxProvider,
  type DockerClientLike,
} from './docker-sandbox-provider.js';
import { UnsafeEgressTargetError } from './egress-proxy.js';
import type { EgressDnsResolver, SandboxContainerConfig } from './egress.js';
import type { SandboxExecutionRequest } from './sandbox-runtime-provider.js';

function createFakeDocker(): {
  client: DockerClientLike;
  config: () => SandboxContainerConfig | undefined;
  createContainer: ReturnType<typeof vi.fn>;
} {
  let captured: SandboxContainerConfig | undefined;
  let stream: PassThrough;
  const createContainer = vi.fn(async (config: SandboxContainerConfig) => {
    captured = config;

    return {
      kill: vi.fn(async () => undefined),
      attach: vi.fn(async () => {
        stream = new PassThrough();
        return stream;
      }),
      start: vi.fn(async () => {
        stream.write('output');
        stream.end();
      }),
      remove: vi.fn(async () => undefined),
    };
  });

  return {
    createContainer,
    config: () => captured,
    client: {
      createContainer,
      modem: {
        demuxStream: (source, stdout) => {
          source.on('data', (chunk: Buffer) => {
            stdout.write(chunk);
          });
        },
      },
      ping: async () => ({}),
    },
  };
}

function request(overrides: Partial<SandboxExecutionRequest> = {}): SandboxExecutionRequest {
  return {
    code: 'echo hi',
    env: {},
    network: 'none',
    egressAllowlist: [],
    timeoutMs: 10_000,
    memoryLimitBytes: 128 * 1024 * 1024,
    nanoCpus: 500_000_000,
    ...overrides,
  };
}

const OPTIONS = {
  image: 'skillwharf-sandbox:latest',
  securityOpts: ['no-new-privileges:true'],
  memoryLimitBytes: 128 * 1024 * 1024,
  nanoCpus: 500_000_000,
  timeoutMs: 10_000,
};

describe('DockerSandboxProvider — поведение по умолчанию', () => {
  it('без allowlist запускает контейнер в none с прежним конфигом', async () => {
    const fake = createFakeDocker();
    const resolve4 = vi.fn(async () => ['1.2.3.4']);
    const resolver: EgressDnsResolver = { resolve4, resolve6: async () => [] };
    const provider = new DockerSandboxProvider({
      ...OPTIONS,
      docker: fake.client,
      egressResolver: resolver,
    });

    await expect(provider.execute(request())).resolves.toEqual({
      stdout: 'output',
      stderr: '',
      timedOut: false,
    });
    expect(fake.config()?.HostConfig.NetworkMode).toBe('none');
    expect(fake.config()?.User).toBe('65534:65534');
    expect(fake.config()?.HostConfig.CapAdd).toBeUndefined();
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('без allowlist не добавляет proxy-env', async () => {
    const fake = createFakeDocker();
    const provider = new DockerSandboxProvider({
      ...OPTIONS,
      docker: fake.client,
      egressProxyUrl: 'http://sandbox-worker:3128',
    });

    await provider.execute(request());

    expect(fake.config()?.Env).toEqual([]);
  });

  it('healthCheck возвращает true, если docker отвечает', async () => {
    const provider = new DockerSandboxProvider({
      ...OPTIONS,
      docker: createFakeDocker().client,
    });

    await expect(provider.healthCheck()).resolves.toBe(true);
  });
});

describe('DockerSandboxProvider — egress-контур (SEC-25.3)', () => {
  const publicResolver: EgressDnsResolver = {
    resolve4: async () => ['1.2.3.4'],
    resolve6: async () => [],
  };

  it('при allowlist запускает bridge, добавляет ExtraHosts и proxy-env', async () => {
    const fake = createFakeDocker();
    const provider = new DockerSandboxProvider({
      ...OPTIONS,
      docker: fake.client,
      egressResolver: publicResolver,
      egressProxyUrl: 'http://sandbox-worker:3128',
    });

    await provider.execute(
      request({
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
    );

    expect(fake.config()?.HostConfig.NetworkMode).toBe('bridge');
    expect(fake.config()?.HostConfig.ExtraHosts).toEqual([
      'api.tavily.com:1.2.3.4',
    ]);
    expect(fake.config()?.Env).toContain('HTTP_PROXY=http://sandbox-worker:3128');
  });

  it.each(['169.254.169.254', '127.0.0.1'])(
    'блокирует DNS rebinding в %s до создания контейнера',
    async (address) => {
      const fake = createFakeDocker();
      const resolver: EgressDnsResolver = {
        resolve4: async () => [address],
        resolve6: async () => [],
      };
      const provider = new DockerSandboxProvider({
        ...OPTIONS,
        docker: fake.client,
        egressResolver: resolver,
      });

      await expect(
        provider.execute(
          request({ network: 'bridge', egressAllowlist: ['api.tavily.com'] }),
        ),
      ).rejects.toThrow(UnsafeEgressTargetError);
      expect(fake.createContainer).not.toHaveBeenCalled();
    },
  );
});
