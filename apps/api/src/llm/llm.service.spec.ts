import { LlmService } from './llm.service.js';

const ENV_KEYS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;

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
    const service = new LlmService();

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

    const service = new LlmService();

    expect(service.isConfigured()).toBe(true);
  });

  it('работает как заглушка, если задан только адрес без имени модели', async () => {
    process.env.LLM_BASE_URL = 'http://localhost:11434/v1';

    const service = new LlmService();

    expect(service.isConfigured()).toBe(false);
    await expect(service.chat([{ role: 'user', content: 'тест' }])).resolves.toBe(
      'LLM not configured: тест',
    );
  });
});
