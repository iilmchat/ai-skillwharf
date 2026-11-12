import {
  resolveNetworkMode,
  SANDBOX_NETWORK_FLAG,
} from './sandbox.service.js';

describe('resolveNetworkMode', () => {
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

  it('по умолчанию изолирует контейнер от сети', () => {
    expect(resolveNetworkMode({})).toBe('none');
    expect(resolveNetworkMode({ TAVILY_API_KEY: 'key' })).toBe('none');
  });

  it('включает bridge по явному флагу', () => {
    expect(resolveNetworkMode({ [SANDBOX_NETWORK_FLAG]: 'true' })).toBe(
      'bridge',
    );
    expect(resolveNetworkMode({ [SANDBOX_NETWORK_FLAG]: 'false' })).toBe(
      'none',
    );
  });

  it('включает bridge для всех вызовов при SANDBOX_ALLOW_NETWORK=true', () => {
    process.env.SANDBOX_ALLOW_NETWORK = 'true';

    expect(resolveNetworkMode({})).toBe('bridge');
  });
});
