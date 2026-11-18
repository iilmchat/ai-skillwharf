import type { Socket } from 'node:net';
import {
  authorizeEgressHost,
  EgressForwardProxy,
  extractHttpHost,
  isBlockedIpAddress,
  isHostAllowed,
  parseClientHelloSni,
  parseHttpHost,
  UnsafeEgressTargetError,
  validateEgressAllowlist,
} from './egress-proxy.js';
import type { EgressDnsResolver } from './egress.js';

/** Собирает валидный TLS ClientHello с SNI и дополнительным extension. */
function buildClientHello(serverName: string): Uint8Array {
  const name = Buffer.from(serverName, 'ascii');
  const entry = Buffer.concat([
    Buffer.from([0x00]), // host_name
    Buffer.from([name.length >> 8, name.length & 0xff]),
    name,
  ]);
  const list = Buffer.concat([
    Buffer.from([entry.length >> 8, entry.length & 0xff]),
    entry,
  ]);
  const sniExtension = Buffer.concat([
    Buffer.from([0x00, 0x00]), // server_name
    Buffer.from([list.length >> 8, list.length & 0xff]),
    list,
  ]);
  //_extension, который парсер должен пропустить (supported_groups).
  const otherExtension = Buffer.from([0x00, 0x0a, 0x00, 0x02, 0x00, 0x1d]);
  const extensions = Buffer.concat([otherExtension, sniExtension]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version
    Buffer.alloc(32, 0xaa), // random
    Buffer.from([0x00]), // session_id length
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher_suites
    Buffer.from([0x01, 0x00]), // compression_methods
    Buffer.from([extensions.length >> 8, extensions.length & 0xff]),
    extensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from([
      (body.length >> 16) & 0xff,
      (body.length >> 8) & 0xff,
      body.length & 0xff,
    ]),
    body,
  ]);

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x16, 0x03, 0x01]),
      Buffer.from([handshake.length >> 8, handshake.length & 0xff]),
      handshake,
    ]),
  );
}

function fakeResolver(
  addresses4: Record<string, readonly string[]> = {},
  addresses6: Record<string, readonly string[]> = {},
): EgressDnsResolver {
  return {
    resolve4: async (fqdn) => addresses4[fqdn] ?? [],
    resolve6: async (fqdn) => addresses6[fqdn] ?? [],
  };
}

describe('TLS ClientHello SNI parser', () => {
  it('извлекает SNI и пропускает другие extensions', () => {
    expect(parseClientHelloSni(buildClientHello('api.tavily.com'))).toBe('api.tavily.com');
  });

  it('нормализует регистр домена', () => {
    expect(parseClientHelloSni(buildClientHello('API.TAVILY.COM'))).toBe('api.tavily.com');
  });

  it('отвергает IP-литерал и не-FQDN в SNI', () => {
    expect(parseClientHelloSni(buildClientHello('169.254.169.254'))).toBeUndefined();
    expect(parseClientHelloSni(buildClientHello('localhost'))).toBeUndefined();
    expect(parseClientHelloSni(buildClientHello('*.evil.com'))).toBeUndefined();
  });

  it('возвращает undefined на пустом и битом буфере', () => {
    expect(parseClientHelloSni(new Uint8Array())).toBeUndefined();
    expect(parseClientHelloSni(new Uint8Array([0x16, 0x03]))).toBeUndefined();
    const hello = buildClientHello('api.tavily.com');

    expect(parseClientHelloSni(hello.subarray(0, 20))).toBeUndefined();
    const broken = Uint8Array.from(hello);
    broken[0] = 0x17; // не handshake record

    expect(parseClientHelloSni(broken)).toBeUndefined();
  });
});

describe('HTTP Host и точное совпадение с allowlist', () => {
  it('парсит Host с портом и из сырых заголовков', () => {
    expect(parseHttpHost('api.tavily.com:443')).toBe('api.tavily.com');
    expect(extractHttpHost('GET / HTTP/1.1\r\nHOST: API.Tavily.com:80\r\n')).toBe(
      'api.tavily.com',
    );
  });

  it('отвергает IP,Scheme, wildcard и несколько Host', () => {
    expect(parseHttpHost('169.254.169.254')).toBeUndefined();
    expect(parseHttpHost('[::1]:443')).toBeUndefined();
    expect(parseHttpHost('http://api.tavily.com')).toBeUndefined();
    expect(parseHttpHost('api.tavily.com, evil.com')).toBeUndefined();
  });

  it('пропускает только точное совпадение домена', () => {
    const allowlist = ['api.tavily.com', 'api.github.com'];

    expect(isHostAllowed('api.tavily.com', allowlist)).toBe(true);
    expect(isHostAllowed('API.TAVILY.COM', allowlist)).toBe(true);
    expect(isHostAllowed('evil.com', allowlist)).toBe(false);
    expect(isHostAllowed('api.tavily.com.evil.com', allowlist)).toBe(false);
    expect(isHostAllowed('notapi.tavily.com', allowlist)).toBe(false);
    expect(isHostAllowed('sub.api.tavily.com', allowlist)).toBe(false);
  });
});

describe('блокировка приватных/metadata IP', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.2',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    'не-ip',
  ])('блокирует %s', (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.2.3.4', '2001:db8::1', '2606:4700:4700::1111'])(
    'пропускает публичный %s',
    (ip) => {
      expect(isBlockedIpAddress(ip)).toBe(false);
    },
  );
});

describe('авторизация egress (KI-028, KI-042)', () => {
  it('пропускает allowlisted FQDN с публичным IP', async () => {
    const result = await authorizeEgressHost(
      'api.tavily.com',
      ['api.tavily.com'],
      fakeResolver({ 'api.tavily.com': ['1.2.3.4'] }),
    );

    expect(result).toEqual({ host: 'api.tavily.com', addresses: ['1.2.3.4'] });
  });

  it('блокирует чужой SNI/Host до резолва', async () => {
    const resolver = fakeResolver({ 'api.tavily.com': ['1.2.3.4'] });

    await expect(
      authorizeEgressHost('evil.com', ['api.tavily.com'], resolver),
    ).rejects.toThrow(UnsafeEgressTargetError);
    await expect(
      authorizeEgressHost('api.tavily.com.evil.com', ['api.tavily.com'], resolver),
    ).rejects.toThrow(UnsafeEgressTargetError);
  });

  it.each(['169.254.169.254', '127.0.0.1', '10.0.0.1', '::1'])(
    'защищает от DNS rebinding в %s',
    async (address) => {
      await expect(
        authorizeEgressHost(
          'api.tavily.com',
          ['api.tavily.com'],
          fakeResolver({ 'api.tavily.com': [address] }),
        ),
      ).rejects.toThrow(/запрещённый IP/);
    },
  );

  it('fail closed при отсутствии A/AAAA-записей', async () => {
    await expect(
      authorizeEgressHost('api.tavily.com', ['api.tavily.com'], fakeResolver()),
    ).rejects.toThrow(/не резолвится/);
  });

  it('проверяет весь allowlist перед запуском песочницы', async () => {
    await expect(
      validateEgressAllowlist(
        ['api.tavily.com'],
        fakeResolver({ 'api.tavily.com': ['169.254.169.254'] }),
      ),
    ).rejects.toThrow(UnsafeEgressTargetError);

    const proxy = new EgressForwardProxy({
      allowlist: ['api.tavily.com'],
      resolver: fakeResolver({ 'api.tavily.com': ['1.2.3.4'] }),
    });

    expect(await proxy.validateAllowlist()).toEqual([
      { host: 'api.tavily.com', addresses: ['1.2.3.4'] },
    ]);
    expect(proxy.isAllowed('evil.com')).toBe(false);
  });
});

describe('EgressForwardProxy.handleConnect: проверка SNI', () => {
  function fakeSocket(): Socket {
    return {
      end: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    } as unknown as Socket;
  }

  it('отклоняет CONNECT с чужим SNI в ClientHello', async () => {
    const proxy = new EgressForwardProxy({
      allowlist: ['api.tavily.com'],
      resolver: fakeResolver({ 'api.tavily.com': ['1.2.3.4'] }),
    });
    const socket = fakeSocket();

    await proxy.handleConnect(
      'api.tavily.com:443',
      socket,
      Buffer.from(buildClientHello('evil.com')),
    );

    expect(socket.end).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  it('отклоняет CONNECT с невалидным SNI', async () => {
    const proxy = new EgressForwardProxy({
      allowlist: ['api.tavily.com'],
      resolver: fakeResolver({ 'api.tavily.com': ['1.2.3.4'] }),
    });
    const socket = fakeSocket();

    await proxy.handleConnect(
      'api.tavily.com:443',
      socket,
      Buffer.from(buildClientHello('169.254.169.254')),
    );

    expect(socket.end).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
});
