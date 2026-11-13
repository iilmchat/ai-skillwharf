import {
  buildContainerConfig,
  buildEgressSetup,
  buildExtraHosts,
  buildHostsEntries,
  DNS_ALLOWED_UID,
  DNS_PORT,
  DNS_RESOLVER_IP,
  EGRESS_ALLOWLIST_ENV,
  EGRESS_SETUP_PATH,
  isCodeTooLong,
  MAX_CODE_LENGTH,
  normalizeEgressAllowlist,
  parseExecutePayload,
  resolveEffectiveNetwork,
  resolveEgressHosts,
  SANDBOX_CODE_ENV,
  type EgressDnsResolver,
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

describe('resolveEgressHosts и buildExtraHosts', () => {
  function fakeResolver(
    map4: Record<string, string[]>,
    map6: Record<string, string[]> = {},
  ): EgressDnsResolver {
    return {
      resolve4: async (fqdn) => {
        const addresses = map4[fqdn];

        if (!addresses) {
          throw new Error('ENOTFOUND');
        }

        return addresses;
      },
      resolve6: async (fqdn) => {
        const addresses = map6[fqdn];

        if (!addresses) {
          throw new Error('ENODATA');
        }

        return addresses;
      },
    };
  }

  it('резолвит v4 и v6, нормализует и дедуплицирует allowlist', async () => {
    const result = await resolveEgressHosts(
      ['api.tavily.com', ' API.Tavily.com '],
      fakeResolver(
        { 'api.tavily.com': ['1.2.3.4', '1.2.3.4'] },
        { 'api.tavily.com': ['2001:db8::1'] },
      ),
    );

    expect(result.resolved).toEqual([
      {
        fqdn: 'api.tavily.com',
        addresses4: ['1.2.3.4'],
        addresses6: ['2001:db8::1'],
      },
    ]);
    expect(result.unresolved).toEqual([]);
    expect(result.ipv6Only).toEqual([]);
  });

  it('пропускает домен с ошибкой DNS, остальные резолвит', async () => {
    const result = await resolveEgressHosts(
      ['bad.example', 'ok.example'],
      fakeResolver({ 'ok.example': ['5.6.7.8'] }),
    );

    expect(result.resolved).toEqual([
      { fqdn: 'ok.example', addresses4: ['5.6.7.8'], addresses6: [] },
    ]);
    expect(result.unresolved).toEqual(['bad.example']);
  });

  it('отдельно помечает IPv6-only домены (ExtraHosts их не поддерживает)', async () => {
    const result = await resolveEgressHosts(
      ['v6.example'],
      fakeResolver({}, { 'v6.example': ['2001:db8::2'] }),
    );

    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.ipv6Only).toEqual(['v6.example']);
  });

  it('строит fqdn:ipv4 и игнорирует IPv6/дубликаты', () => {
    expect(
      buildExtraHosts([
        {
          fqdn: 'api.tavily.com',
          addresses4: ['1.2.3.4', '1.2.3.4'],
          addresses6: ['2001:db8::1'],
        },
        {
          fqdn: 'api.github.com',
          addresses4: ['5.6.7.8', '9.9.9.9'],
          addresses6: [],
        },
      ]),
    ).toEqual([
      'api.tavily.com:1.2.3.4',
      'api.github.com:5.6.7.8',
      'api.github.com:9.9.9.9',
    ]);
  });

  it('дедуплицирует FQDN', () => {
    expect(
      buildExtraHosts([
        { fqdn: 'a.example', addresses4: ['1.1.1.1'], addresses6: [] },
        { fqdn: 'A.example', addresses4: ['2.2.2.2'], addresses6: [] },
      ]),
    ).toEqual(['a.example:1.1.1.1']);
  });

  it('пустой allowlist → пустой ExtraHosts', () => {
    expect(buildExtraHosts([])).toEqual([]);
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
    expect(config.HostConfig.ExtraHosts).toBeUndefined();
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

  it('пробрасывает ExtraHosts для allowlist-доменов (prod-путь hosts)', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'curl https://api.tavily.com',
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
      RUNTIME,
      ['api.tavily.com:1.2.3.4'],
    );

    expect(config.HostConfig.ExtraHosts).toEqual(['api.tavily.com:1.2.3.4']);
  });

  it('без allowlist ExtraHosts не добавляются', () => {
    const config = buildContainerConfig(
      parseExecutePayload({ code: 'echo hi' }),
      RUNTIME,
      ['api.tavily.com:1.2.3.4'],
    );

    expect(config.HostConfig.ExtraHosts).toBeUndefined();
  });

  it('фильтрует ExtraHosts не из allowlist, IPv6 и дубликаты', () => {
    const config = buildContainerConfig(
      parseExecutePayload({
        code: 'true',
        network: 'bridge',
        egressAllowlist: ['api.tavily.com'],
      }),
      RUNTIME,
      [
        'evil.example:6.6.6.6',
        'api.tavily.com:1.2.3.4',
        'api.tavily.com:1.2.3.4',
        'api.tavily.com:2001:db8::1',
      ],
    );

    expect(config.HostConfig.ExtraHosts).toEqual(['api.tavily.com:1.2.3.4']);
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

  it('ставит политику OUTPUT/INPUT/FORWARD DROP и разрешает DNS 127.0.0.11 только root', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => ['1.2.3.4']);

    expect(plan.iptables).toContain('iptables -P OUTPUT DROP');
    expect(plan.iptables).toContain('iptables -P INPUT DROP');
    expect(plan.iptables).toContain('iptables -P FORWARD DROP');
    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p udp -m conntrack --ctorigdst ${DNS} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    );
    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p tcp -m conntrack --ctorigdst ${DNS} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
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
    expect(plan.hosts).toEqual([]);
    expect(onlyAcceptRules(plan.iptables)).toEqual([
      'iptables -A INPUT -i lo -j ACCEPT',
      `iptables -A OUTPUT -p udp -m conntrack --ctorigdst ${DNS} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
      `iptables -A OUTPUT -p tcp -m conntrack --ctorigdst ${DNS} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
      'iptables -A OUTPUT -o lo -j ACCEPT',
      'iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    ]);
  });
});

describe('buildEgressSetup: DNS anti-tunneling', () => {
  it('разрешает DNS 127.0.0.11:53 только root и явно DROP-ает DNS остальным', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => ['1.2.3.4']);

    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p udp -m conntrack --ctorigdst ${DNS_RESOLVER_IP} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    );
    expect(plan.iptables).toContain(
      `iptables -A OUTPUT -p tcp -m conntrack --ctorigdst ${DNS_RESOLVER_IP} --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    );
    expect(plan.iptables).toEqual(
      expect.arrayContaining([
        `iptables -A OUTPUT -p udp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
        `iptables -A OUTPUT -p tcp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
      ]),
    );
  });

  it('DROP DNS стоит до общего loopback-ACCEPT и политики OUTPUT DROP', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => ['1.2.3.4']);
    const dnsDropIndex = plan.iptables.indexOf(
      `iptables -A OUTPUT -p udp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
    );
    const loopbackAcceptIndex = plan.iptables.indexOf(
      'iptables -A OUTPUT -o lo -j ACCEPT',
    );
    const policyIndex = plan.iptables.indexOf('iptables -P OUTPUT DROP');

    expect(dnsDropIndex).toBeGreaterThan(-1);
    // Иначе общий `-o lo ACCEPT` пропускал бы DNS для всех.
    expect(loopbackAcceptIndex).toBeGreaterThan(dnsDropIndex);
    expect(policyIndex).toBeGreaterThan(loopbackAcceptIndex);
  });

  it('DROP DNS матчит оригинальный dport (conntrack), а не --dport после DNAT', () => {
    const plan = buildEgressSetup([], () => []);

    for (const rule of plan.iptables) {
      if (rule.includes('-j DROP')) {
        expect(rule).toContain('--ctorigdstport');
        expect(rule).not.toContain('--dport');
      }
    }
  });
});

describe('buildEgressSetup: ip6tables', () => {
  it('строит явные DROP-правила и DNS-DROP для IPv6', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => ['2001:db8::1']);

    expect(plan.ip6tables).toEqual(
      expect.arrayContaining([
        'ip6tables -A INPUT -i lo -j ACCEPT',
        'ip6tables -A OUTPUT -o lo -j ACCEPT',
        'ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
        'ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
        `ip6tables -A OUTPUT -p udp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
        `ip6tables -A OUTPUT -p tcp -m conntrack --ctorigdstport ${DNS_PORT} -j DROP`,
        'ip6tables -P INPUT DROP',
        'ip6tables -P FORWARD DROP',
        'ip6tables -P OUTPUT DROP',
      ]),
    );
    expect(plan.ip6tables).toContain(
      'ip6tables -A OUTPUT -p tcp -d 2001:db8::1 --dport 443 -j ACCEPT',
    );
  });

  it('разрешает DNS к ::1 только root', () => {
    const plan = buildEgressSetup([], () => []);

    expect(plan.ip6tables).toContain(
      `ip6tables -A OUTPUT -p udp -m conntrack --ctorigdst ::1 --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    );
    expect(plan.ip6tables).toContain(
      `ip6tables -A OUTPUT -p tcp -m conntrack --ctorigdst ::1 --ctorigdstport ${DNS_PORT} -m owner --uid-owner ${DNS_ALLOWED_UID} -j ACCEPT`,
    );
  });
});

describe('hosts-записи для egress', () => {
  it('строит <ip> <fqdn> для IPv4 и IPv6', () => {
    const plan = buildEgressSetup(['api.tavily.com'], () => [
      '1.2.3.4',
      '2001:db8::1',
    ]);

    expect(plan.hosts).toEqual([
      '1.2.3.4 api.tavily.com',
      '2001:db8::1 api.tavily.com',
    ]);
  });

  it('не пишет hosts для нерезолвнутого домена', () => {
    const plan = buildEgressSetup(['unknown.example'], () => []);

    expect(plan.hosts).toEqual([]);
    expect(plan.unresolved).toEqual(['unknown.example']);
  });

  it('buildHostsEntries сохраняет порядок доменов и IP', () => {
    expect(
      buildHostsEntries({
        'a.example': ['1.1.1.1'],
        'b.example': ['2.2.2.2', '2001:db8::2'],
      }),
    ).toEqual([
      '1.1.1.1 a.example',
      '2.2.2.2 b.example',
      '2001:db8::2 b.example',
    ]);
  });
});
