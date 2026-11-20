import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { SpeechToTextService } from './speech-to-text.service.js';

const AUDIO = Buffer.from('fake-audio-bytes').toString('base64');
const REQUEST = { audioBase64: AUDIO, mimeType: 'audio/webm', language: 'ru' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SpeechToTextService (VOICE-38.1)', () => {
  it('mock-провайдер возвращает детерминированный текст', async () => {
    const service = new SpeechToTextService({ STT_PROVIDER: 'mock' });

    const result = await service.transcribe(REQUEST);

    expect(result.provider).toBe('mock');
    expect(result.text).toContain('ru');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('whisper отправляет multipart и валидирует ответ', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'привет от whisper' }),
    }));
    const service = new SpeechToTextService(
      {
        STT_PROVIDER: 'whisper',
        STT_WHISPER_URL: 'https://stt.example.com/v1',
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await service.transcribe(REQUEST);

    expect(result.text).toBe('привет от whisper');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(url).toBe('https://stt.example.com/v1/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('yandex-speechkit шлёт Bearer и base64 аудио', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'распознано speechkit' }),
    }));
    const service = new SpeechToTextService(
      {
        STT_PROVIDER: 'yandex-speechkit',
        YANDEX_STT_IAM_TOKEN: 'iam-token',
      },
      fetchMock as unknown as typeof fetch,
    );

    const result = await service.transcribe(REQUEST);

    expect(result.provider).toBe('yandex-speechkit');
    expect(result.text).toBe('распознано speechkit');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe('https://yandex.net');
    expect(headers.Authorization).toBe('Bearer iam-token');
    expect(init.body).toContain(AUDIO);
  });

  it('отвергает неподдерживаемый MIME-тип через Zod', async () => {
    const service = new SpeechToTextService({ STT_PROVIDER: 'mock' });

    await expect(
      service.transcribe({ ...REQUEST, mimeType: 'video/mp4' }),
    ).rejects.toThrow();
  });

  it('отвергает слишком большой аудиофайл (413)', async () => {
    const service = new SpeechToTextService({ STT_PROVIDER: 'mock' });
    const huge = Buffer.alloc(16 * 1024 * 1024).toString('base64');

    try {
      await service.transcribe({ ...REQUEST, audioBase64: huge });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(413);
    }
  });
});
