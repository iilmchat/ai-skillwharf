import {
  normalizeEgressAllowlist,
  planSandboxNetwork,
  SANDBOX_NETWORK_FLAG,
} from './egress.js';
import { SandboxService } from './sandbox.service.js';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    post: postMock,
    isAxiosError: vi.fn(() => false),
  },
}));

const WORKER_OK = {
  data: { stdout: 'ok\n', stderr: '', timedOut: false },
};

describe('planSandboxNetwork', () => {
  const originalAllowNetwork = process.env.SANDBOX_ALLOW_NETWORK;

  beforeEach(() => {
    delete process.env.SANDBOX_ALLOW_NETWORK;
  });

  afterEach(() => {
    if (originalAllowNetwork === undefined) {
      delete process.env.SANDBOX_ALLOW_NETWORK;
    } else {
      process.env.SANDBOX_ALLOW_NETWORK = originalAllowNetwork;
    }
  });

  it('без политики запрещает сеть', () => {
    expect(planSandboxNetwork()).toEqual({
      network: 'none',
      egressAllowlist: [],
    });
    expect(planSandboxNetwork({ allowlist: [] })).toEqual({
      network: 'none',
      egressAllowlist: [],
    });
  });

  it('не включает сеть по legacy-флагу SANDBOX_ALLOW_NETWORK', () => {
    process.env.SANDBOX_ALLOW_NETWORK = 'true';

    expect(planSandboxNetwork()).toEqual({
      network: 'none',
      egressAllowlist: [],
    });
  });

  it('включает bridge только при непустом allowlist', () => {
    expect(planSandboxNetwork({ allowlist: ['api.tavily.com'] })).toEqual({
      network: 'bridge',
      egressAllowlist: ['api.tavily.com'],
    });
  });

  it('пробрасывает несколько доменов в исходном порядке', () => {
    expect(
      planSandboxNetwork({
        allowlist: ['api.tavily.com', 'api.github.com', 'example.org'],
      }),
    ).toEqual({
      network: 'bridge',
      egressAllowlist: ['api.tavily.com', 'api.github.com', 'example.org'],
    });
  });

  it('нормализует пробелы и регистр, схлопывает дубликаты', () => {
    expect(
      normalizeEgressAllowlist([' API.Tavily.com ', 'api.tavily.com']),
    ).toEqual(['api.tavily.com']);
  });

  it.each([
    '*.evil.com',
    'http://evil.com',
    'evil.com:443',
    'evil.com/path',
    '10.0.0.1',
    '',
  ])('отклоняет невалидный домен %s', (domain) => {
    expect(() => planSandboxNetwork({ allowlist: [domain] })).toThrow(
      /egress\.allowlist/,
    );
  });

  it('отклоняет больше 50 доменов', () => {
    const allowlist = Array.from(
      { length: 51 },
      (_value, index) => `host-${index}.example.com`,
    );

    expect(() => planSandboxNetwork({ allowlist })).toThrow(
      /не более 50 доменов/,
    );
  });
});

describe('SandboxService.runCommand', () => {
  const originalAllowNetwork = process.env.SANDBOX_ALLOW_NETWORK;

  beforeEach(() => {
    delete process.env.SANDBOX_ALLOW_NETWORK;
    postMock.mockReset();
    postMock.mockResolvedValue(WORKER_OK);
  });

  afterEach(() => {
    if (originalAllowNetwork === undefined) {
      delete process.env.SANDBOX_ALLOW_NETWORK;
    } else {
      process.env.SANDBOX_ALLOW_NETWORK = originalAllowNetwork;
    }
  });

  it('без allowlist отправляет network=none, даже если SANDBOX_ALLOW_NETWORK=true', async () => {
    process.env.SANDBOX_ALLOW_NETWORK = 'true';
    const service = new SandboxService();

    await expect(service.runCommand('echo hi')).resolves.toBe('ok\n');

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(
      expect.stringContaining('/execute'),
      expect.objectContaining({
        code: 'echo hi',
        env: {},
        network: 'none',
        egressAllowlist: [],
      }),
      expect.anything(),
    );
  });

  it('с allowlist включает bridge и передаёт домены worker-у', async () => {
    const service = new SandboxService();

    await service.runCommand('curl https://api.tavily.com', {}, {
      egress: { allowlist: ['api.tavily.com'] },
    });

    expect(postMock).toHaveBeenCalledWith(
      expect.stringContaining('/execute'),
      expect.objectContaining({
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
      expect.anything(),
    );
  });

  it('передаёт несколько доменов', async () => {
    const service = new SandboxService();

    await service.runCommand('true', {}, {
      egress: {
        allowlist: ['api.tavily.com', 'api.github.com', 'example.org'],
      },
    });

    const [, payload] = postMock.mock.calls[0] as [
      string,
      { egressAllowlist: string[] },
    ];

    expect(payload.egressAllowlist).toEqual([
      'api.tavily.com',
      'api.github.com',
      'example.org',
    ]);
  });

  it('вычищает legacy-флаг ALLOW_NETWORK из env контейнера', async () => {
    const service = new SandboxService();

    await service.runCommand('echo hi', {
      [SANDBOX_NETWORK_FLAG]: 'true',
      TAVILY_API_KEY: 'secret',
    });

    const [, payload] = postMock.mock.calls[0] as [
      string,
      { env: Record<string, string>; network: string },
    ];

    expect(payload.env).toEqual({ TAVILY_API_KEY: 'secret' });
    expect(payload.env).not.toHaveProperty(SANDBOX_NETWORK_FLAG);
    expect(payload.network).toBe('none');
  });

  it('не делает HTTP-вызов при невалидном домене', async () => {
    const service = new SandboxService();

    await expect(
      service.runCommand('curl evil', {}, {
        egress: { allowlist: ['*.evil.com'] },
      }),
    ).rejects.toThrow(/egress\.allowlist/);

    expect(postMock).not.toHaveBeenCalled();
  });

  it('возвращает stdout и пробрасывает ошибку worker-а', async () => {
    const service = new SandboxService();
    postMock.mockRejectedValueOnce(new Error('connection refused'));

    await expect(service.runCommand('echo hi')).rejects.toThrow(
      'sandbox-worker: connection refused',
    );
  });

  it('падает по таймауту worker-а', async () => {
    const service = new SandboxService();
    postMock.mockResolvedValueOnce({
      data: { stdout: '', stderr: '', timedOut: true },
    });

    await expect(service.runCommand('sleep 100')).rejects.toThrow(
      /превысила лимит/,
    );
  });
});
