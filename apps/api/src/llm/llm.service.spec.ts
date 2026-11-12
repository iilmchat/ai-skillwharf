import { BadRequestException } from '@nestjs/common';
import type { SandboxService } from '../sandbox/sandbox.service.js';
import {
  LlmService,
  SANDBOX_TOOL_DESCRIPTION,
  SANDBOX_TOOL_NAME,
} from './llm.service.js';

const ENV_KEYS = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
] as const;

type MockFn = ReturnType<typeof vi.fn>;

interface SandboxMock {
  runCommand: MockFn;
}

function createSandbox(): SandboxMock {
  return { runCommand: vi.fn() };
}

function createService(sandbox: SandboxMock = createSandbox()): LlmService {
  return new LlmService(sandbox as unknown as SandboxService);
}

describe('LlmService', () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('возвращает эхо-заглушку, если LLM не настроен', async () => {
    const service = createService();

    expect(service.isConfigured()).toBe(false);
    await expect(
      service.chat([
        { role: 'user', content: 'первое сообщение' },
        { role: 'assistant', content: 'ответ ассистента' },
        { role: 'user', content: 'второе сообщение' },
      ]),
    ).resolves.toBe('LLM not configured: второе сообщение');
  });

  it('считается настроенным при заданных LLM_BASE_URL и LLM_MODEL', () => {
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.LLM_MODEL = 'llama3';

    const service = createService();

    expect(service.isConfigured()).toBe(true);
  });

  it('работает как заглушка, если задан только адрес без имени модели', async () => {
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    const service = createService();

    expect(service.isConfigured()).toBe(false);
    await expect(service.chat([{ role: 'user', content: 'тест' }])).resolves.toBe(
      'LLM not configured: тест',
    );
  });

  describe('createSandboxTool', () => {
    it('выполняет код через SandboxService и возвращает stdout', async () => {
      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('hello\n');
      const service = createService(sandbox);

      const tool = service.createSandboxTool();

      expect(tool.name).toBe(SANDBOX_TOOL_NAME);
      expect(tool.description).toBe(SANDBOX_TOOL_DESCRIPTION);
      await expect(tool.invoke({ code: 'echo hello' })).resolves.toBe(
        'hello\n',
      );
      expect(sandbox.runCommand).toHaveBeenCalledWith('echo hello', {});
    });

    it('передаёт в песочницу только разрешённые секреты', async () => {
      process.env.TAVILY_API_KEY = 'tavily-key';
      process.env.GITHUB_TOKEN = 'gh-token';
      // Не входит в allowlist и не должно попасть в контейнер.
      process.env.LLM_API_KEY = 'llm-key';

      const sandbox = createSandbox();
      sandbox.runCommand.mockResolvedValue('ok');
      const service = createService(sandbox);

      await service.createSandboxTool().invoke({ code: 'echo ok' });

      expect(sandbox.runCommand).toHaveBeenCalledWith('echo ok', {
        TAVILY_API_KEY: 'tavily-key',
        GITHUB_TOKEN: 'gh-token',
      });
    });

    it('вызывает paywall-хук до запуска кода', async () => {
      const order: string[] = [];
      const sandbox = createSandbox();
      sandbox.runCommand.mockImplementation(async () => {
        order.push('run');
        return 'ok';
      });
      const service = createService(sandbox);
      const beforeExecute = vi.fn(async () => {
        order.push('charge');
      });

      const tool = service.createSandboxTool({ beforeExecute });
      await tool.invoke({ code: 'echo ok' });

      expect(order).toEqual(['charge', 'run']);
    });

    it('не запускает код, если paywall-хук выбросил ошибку', async () => {
      const sandbox = createSandbox();
      const service = createService(sandbox);
      const beforeExecute = vi
        .fn()
        .mockRejectedValue(new BadRequestException('Недостаточно средств'));

      const tool = service.createSandboxTool({ beforeExecute });

      await expect(tool.invoke({ code: 'echo ok' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sandbox.runCommand).not.toHaveBeenCalled();
    });
  });
});
