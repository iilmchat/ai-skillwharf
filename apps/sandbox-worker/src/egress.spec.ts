import {
  buildContainerConfig,
  buildEgressSetup,
  DNS_RESOLVER_IP,
  EGRESS_ALLOWLIST_ENV,
  EGRESS_SETUP_PATH,
  isCodeTooLong,
  MAX_CODE_LENGTH,
  normalizeEgressAllowlist,
  parseExecutePayload,
  resolveEffectiveNetwork,
  SANDBOX_CODE_ENV,
  type SandboxRuntimeConfig,
} from './egress.js';

const RUNTIME: SandboxRuntimeConfig = {
  image: 'skillwharf-sandbox:latest',
  securityOpts: [
    'no-new-privileges:true',
    'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}',
  ],
  memoryLimitBytes: 128 * 1024 * 1024,
  nanoCpus: 500_000_000,
};

describe('parseExecutePayload', () => {
  it('применяет безопасные значения по умолчанию: none и пустой allowlist', () => {
    expect(parseExecutePayload({ code: 'echo hi' })).toEqual({
      code: 'echo hi',
      env: {},
      network: 'none',
      egressAllowlist: [],
    });
  });

  it('принимает bridge с allowlist', () => {
    expect(
      parseExecutePayload({
        code: 'curl https://api.tavily.com',
        env: { TAVILY_API_KEY: 'key' },
        network: 'bridge',
        egressAllowlist: ['api.tavily.com', 'api.github.com'],
      }),
    ).toEqual({
      code: 'curl https://api.tavily.com',
      env: { TAVILY_API_KEY: 'key' },
      network: 'bridge',
      egressAllowlist: ['api.tavily.com', 'api.github.com'],
    });
  });

  it.each([
    ['wildcard', '*.evil.com'],
    ['схему', 'http://evil.com'],
    ['порт', 'evil.com:443'],
    ['IP', '10.0.0.1'],
    ['верхний регистр', 'API.tavily.com'],
  ])('не пропускает домен с %s', (_label, domain) => {
    expect(() =>
      parseExecutePayload({ code: 'true', egressAllowlist: [domain] }),
    ).toThrow(/некорректный payload/);
  });

  it('не пропускает больше 50 доменов', () => {
    const egressAllowlist = Array.from(
      { length: 51 },
      (_value, index) => `host-${index}.example.com`,
    );

    expect(() =>
      parseExecutePayload({ code: 'true', egressAllowlist }),
    ).toThrow(/некорректный payload/);
  });

  it('не пропускает пустой code', () => {
    expect(() => parseExecutePayload({ code: '' })).toThrow(
      /некорректный payload/,
    );
  });

  it('isCodeTooLong срабатывает только на превышении лимита', () => {
    expect(isCodeTooLong({ code: 'echo hi' })).toBe(false);
    expect(isCodeTooLong({ code: 'x'.repeat(MAX_CODE_LENGTH + 1) })).toBe(true);
    expect(isCodeTooLong({})).toBe(false);
    expect(isCodeTooLong(undefined)).toBe(false);
  });
});

describe('normalizeEgressAllowlist и resolveEffectiveNetwork', () => {
  it('нормализует регистр, пробелы и дубликаты', () => {
    expect(
      normalizeEgressAllowlist([' API.Tavily.com ', 'api.tavily.com']),
    ).toEqual(['api.tavily.com']);
  });

  it('bridge без allowlist принудительно превращается в none', () => {
    const payload = parseExecutePayload({ code: 'true', network: 'bridge' });

    expect(resolveEffectiveNetwork(payload)).toEqual({
      network: 'none',
      egressAllowlist: [],
    });
  });

  it('none с allowlist остаётся none (allowlist не включает сеть сам по себе)', () => {
    const payload = parseExecutePayload({
      code: 'true',
      network: 'none',
      egressAllowlist: ['api.tavily.com'],
    });

    expect(resolveEffectiveNetwork(payload)).toEqual({
      network: 'none',
      egressAllowlist: [],
    });
  });
});

describe('buildContainerConfig', () => {
  it('без allowlist: network none, без NET_ADMIN и entrypoint, User 65534', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'echo hi',
        env: { TAVILY_API_KEY: 'key' },
      }),
      RUNTIME,
    );

    expect(config.HostConfig.NetworkMode).toBe('none');
    expect(config.HostConfig.CapAdd).toBeUndefined();
    expect(config.HostConfig.CapDrop).toEqual(['ALL']);
    expect(config.Entrypoint).toBeUndefined();
    expect(config.User).toBe('65534:65534');
    expect(config.HostConfig.Tmpfs).toEqual({ '/tmp': '' });
    expect(config.Cmd).toEqual(['sh', '-c', 'echo hi']);
    expect(config.Env).toEqual(['TAVILY_API_KEY=key']);
  });

  it('с allowlist: bridge, capabilities для iptables и su-exec, entrypoint setup', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'curl https://api.tavily.com',
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
      RUNTIME,
    );

    expect(config.HostConfig.NetworkMode).toBe('bridge');
    // NET_ADMIN — iptables, SETUID/SETGID — su-exec для сброса прав до 65534.
    expect(config.HostConfig.CapAdd).toEqual([
      'NET_ADMIN',
      'SETUID',
      'SETGID',
    ]);
    expect(config.Entrypoint).toEqual([EGRESS_SETUP_PATH]);
    // Код выполняется от 65534 после настройки iptables.
    expect(config.User).toBeUndefined();
    expect(config.HostConfig.Tmpfs).toEqual({ '/tmp': '', '/run': '' });
    expect(config.Env).toContain(
      `${EGRESS_ALLOWLIST_ENV}=${JSON.stringify(['api.tavily.com'])}`,
    );
    expect(config.Env).toContain(`${SANDBOX_CODE_ENV}=curl https://api.tavily.com`);
  });

  it('bridge без allowlist не создаёт контейнер в сети', () => {
    const config = buildContainerConfig(
      parseExecutePayload({ code: 'true', network: 'bridge' }),
      RUNTIME,
    );

    expect(config.HostConfig.NetworkMode).toBe('none');
    expect(config.HostConfig.CapAdd).toBeUndefined();
    expect(config.Entrypoint).toBeUndefined();
    expect(config.User).toBe('65534:65534');
  });

  it('вычищает зарезервированные env-ключи из пользовательского env', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'true',
        env: {
          ALLOW_NETWORK: 'true',
          [EGRESS_ALLOWLIST_ENV]: '["evil.com"]',
          [SANDBOX_CODE_ENV]: 'rm -rf /',
          TAVILY_API_KEY: 'key',
        },
      }),
      RUNTIME,
    );

    expect(config.Env).toEqual(['TAVILY_API_KEY=key']);
  });

  it('сохраняет seccomp/no-new-privileges из securityOpts worker-а', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'true',
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
      RUNTIME,
    );

    expect(config.HostConfig.SecurityOpt).toEqual(RUNTIME.securityOpts);
    expect(config.HostConfig.ReadonlyRootfs).toBe(true);
    expect(config.HostConfig.Memory).toBe(RUNTIME.memoryLimitBytes);
    expect(config.HostConfig.NanoCpus).toBe(RUNTIME.nanoCpus);
  });
});

describe('buildEgressSetup', () => {
  const DNS = DNS_RESOLVER_IP;

  function onlyAcceptRules(rules: readonly string[]): string[] {
    return rules.filter((rule) => rule.includes('-j ACCEPT'));
  }

  it('разрешает 80/443 только для IP, в которые резолвятся домены allowlist', () => {
    const plan = buildEgressSetup(
      ['api.tavily.com', 'api.github.com'],
      (fqdn) => {
        if (fqdn === 'api.tavily.com') {
          return ['1.2.3.4'];
        }

        if (fqdn === 'api.github.com') {
          return ['5.6.7.8'];
        }

        return [];
      },
    );

    expect(plan.resolved).toEqual({
      'api.tavily.com': ['1.2.3.4'],
      'api.github.com': ['5.6.7.8'],
    });
    expect(onlyAcceptRules(plan.iptables)).toEqual(
      expect.arrayContaining([
        `iptables -A OUTPUT -p tcp -d 1.2.3.4 --dport 80 -j ACCEPT`,
        `iptables -A OUTPUT -p tcp -d 1.2.3.4 --dport 443 -j ACCEPT`,
        `iptables -A OUTPUT -p tcp -d 5.6.7.8 --dport 443 -j ACCEPT`,
      ]),
    );
    expect(
      plan.iptables.filter((rule) => rule.includes('-d 1.2.3.4')),
    ).toHaveLength(2);
  });

  it('ставит политику OUTPUT/INPUT/FORWARD DROP и разрешает DNS 127.0.0.11', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => ['1.2.3.4']);

    expect(plan.iptables).toContain('iptables -P OUTPUT DROP');
    expect(plan.iptables).toContain('iptables -P INPUT DROP');
    expect(plan.iptables).toContain('iptables -P FORWARD DROP');
    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p udp -d ${DNS} --dport 53 -j ACCEPT`,
    );
    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p tcp -d ${DNS} --dport 53 -j ACCEPT`,
    );
    expect(plan.iptables).toContain(
      'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    );
    expect(plan.iptables.at(-1)).toBe('iptables -P OUTPUT DROP');
  });

  it('не даёт ACCEPT нерезолвнутому домену', () => {
    const plan = buildEgressSetup(
      ['api.tavily.com', 'unknown.example'],
      (fqdn) => (fqdn === 'api.tavily.com' ? ['1.2.3.4'] : []),
    );

    expect(plan.unresolved).toEqual(['unknown.example']);
    expect(plan.resolved).toEqual({ 'api.tavily.com': ['1.2.3.4'] });

    const domainAccepts = onlyAcceptRules(plan.iptables).filter((rule) =>
      /--dport (?:80|443)/.test(rule),
    );

    expect(domainAccepts).toEqual([
      'iptables -A OUTPUT -p tcp -d 1.2.3.4 --dport 80 -j ACCEPT',
      'iptables -A OUTPUT -p tcp -d 1.2.3.4 --dport 443 -j ACCEPT',
    ]);
  });

  it('резолвит только домены из allowlist', () => {
    const resolveHost = vi.fn(() => ['1.2.3.4']);

    buildEgressSetup(['api.tavily.com', 'api.github.com'], resolveHost);

    expect(resolveHost.mock.calls).toEqual([['api.tavily.com'], ['api.github.com']]);
  });

  it('добавляет IPv6-правила для найденных AAAA-адресов', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => [
      '1.2.3.4',
      '2001:db8::1',
    ]);

    expect(plan.ip6tables).toContain(
      'ip6tables -A OUTPUT -p tcp -d 2001:db8::1 --dport 443 -j ACCEPT',
    );
    expect(plan.ip6tables).toContain('ip6tables -P OUTPUT DROP');
    expect(plan.iptables).not.toEqual(
      expect.arrayContaining([expect.stringContaining('2001:db8::1')]),
    );
  });

  it('пустой allowlist не добавляет ни одного domain-ACCEPT', () => {
    const plan = buildEgressSetup([], () => ['1.2.3.4']);

    expect(plan.resolved).toEqual({});
    expect(plan.unresolved).toEqual([]);
    expect(onlyAcceptRules(plan.iptables)).toEqual([
      'iptables -A INPUT -i lo -j ACCEPT',
      'iptables -A OUTPUT -o lo -j ACCEPT',
      `iptables -A OUTPUT -p udp -d ${DNS} --dport 53 -j ACCEPT`,
      `iptables -A OUTPUT -p tcp -d ${DNS} --dport 53 -j ACCEPT`,
      'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    ]);
  });
});
