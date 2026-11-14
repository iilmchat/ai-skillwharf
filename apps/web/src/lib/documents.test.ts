import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  DOCUMENTS_ENDPOINT,
  DOCUMENT_ERROR_KEYS,
  MAX_DOCUMENT_BYTES,
  classifyDocumentError,
  documentToChatText,
  formatDocumentSize,
  normalizeParsedDocument,
  parsedDocumentSchema,
  resolveDocumentMimeType,
  uploadDocument,
  uploadProgressPercent,
  validateDocumentFile,
} from './documents';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { post: postMock },
}));

const DOCUMENT_RESPONSE = {
  id: 'doc-1',
  filename: 'resume.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  kind: 'pdf',
  text: 'Анна Петрова',
  tables: [
    {
      title: 'Опыт',
      columns: ['Компания', 'Годы'],
      rows: [['Яндекс', '2021—2025']],
    },
  ],
  createdAt: '2026-11-14T10:00:00.000Z',
};

function createFile(
  name = 'resume.pdf',
  type = 'application/pdf',
  size = 4,
): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('validateDocumentFile', () => {
  it('принимает PDF и картинки из поддерживаемых MIME', () => {
    expect(
      validateDocumentFile({
        name: 'scan.pdf',
        size: 10,
        type: 'application/pdf',
      }),
    ).toEqual({
      ok: true,
      mimeType: 'application/pdf',
      kind: 'pdf',
    });
    expect(
      validateDocumentFile({
        name: 'scan.png',
        size: 10,
        type: 'image/png',
      }),
    ).toEqual({ ok: true, mimeType: 'image/png', kind: 'image' });
  });

  it('выводит MIME из расширения, если браузер его не передал', () => {
    expect(
      validateDocumentFile({ name: 'SCAN.JPEG', size: 10, type: '' }),
    ).toEqual({ ok: true, mimeType: 'image/jpeg', kind: 'image' });
  });

  it('отклоняет неподдерживаемый тип', () => {
    const result = validateDocumentFile({
      name: 'script.exe',
      size: 10,
      type: 'application/octet-stream',
    });

    expect(result).toEqual({
      ok: false,
      errorKey: 'chat.upload.errors.type',
    });
  });

  it('отклоняет пустой и слишком большой файл', () => {
    expect(
      validateDocumentFile({
        name: 'empty.pdf',
        size: 0,
        type: 'application/pdf',
      }),
    ).toEqual({ ok: false, errorKey: 'chat.upload.errors.empty' });
    expect(
      validateDocumentFile({
        name: 'huge.pdf',
        size: MAX_DOCUMENT_BYTES + 1,
        type: 'application/pdf',
      }),
    ).toEqual({ ok: false, errorKey: 'chat.upload.errors.size' });
  });

  it('resolveDocumentMimeType не падает на имени без расширения', () => {
    expect(resolveDocumentMimeType('resume', '')).toBeNull();
    expect(resolveDocumentMimeType('resume.pdf', 'APPLICATION/PDF')).toBe(
      'application/pdf',
    );
  });
});

describe('uploadProgressPercent', () => {
  it('без размера файла прогресс не определён', () => {
    expect(uploadProgressPercent(10, undefined)).toBeNull();
    expect(uploadProgressPercent(10, 0)).toBeNull();
  });

  it('считает процент и не доходит до 100 раньше ответа', () => {
    expect(uploadProgressPercent(0, 100)).toBe(0);
    expect(uploadProgressPercent(50, 100)).toBe(50);
    expect(uploadProgressPercent(999, 1000)).toBe(99);
    expect(uploadProgressPercent(100, 100)).toBe(100);
  });

  it('клампится в диапазон 0–100', () => {
    expect(uploadProgressPercent(-5, 100)).toBe(0);
    expect(uploadProgressPercent(200, 100)).toBe(100);
  });
});

describe('parsedDocumentSchema (контракт POST /documents)', () => {
  it('принимает разобранный документ с таблицами', () => {
    const parsed = parsedDocumentSchema.parse(DOCUMENT_RESPONSE);

    expect(parsed.tables[0]?.rows[0]?.[0]).toBe('Яндекс');
  });

  it('подставляет пустой список таблиц и не требует createdAt', () => {
    const { tables, createdAt, ...rest } = DOCUMENT_RESPONSE;
    const parsed = parsedDocumentSchema.parse(rest);

    expect(tables).toBeDefined();
    expect(createdAt).toBeDefined();
    expect(parsed.tables).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.createdAt).toBeUndefined();
  });

  it('принимает постраничный текст без плоского text', () => {
    const parsed = parsedDocumentSchema.parse({
      ...DOCUMENT_RESPONSE,
      text: undefined,
      pages: [{ text: 'Страница 1' }, { text: 'Страница 2' }],
    });

    expect(parsed.pages).toHaveLength(2);
  });

  it('отклоняет ответ без обязательных полей и с неизвестным kind', () => {
    expect(
      parsedDocumentSchema.safeParse({ ...DOCUMENT_RESPONSE, kind: 'docx' })
        .success,
    ).toBe(false);
    expect(
      parsedDocumentSchema.safeParse({ ...DOCUMENT_RESPONSE, id: '' }).success,
    ).toBe(false);
  });
});

describe('normalizeParsedDocument', () => {
  it('сводит терпимый ответ к модели UI', () => {
    const document = normalizeParsedDocument(DOCUMENT_RESPONSE);

    expect(document.kind).toBe('pdf');
    expect(document.text).toBe('Анна Петрова');
    expect(document.tables[0]?.columns).toEqual(['Компания', 'Годы']);
    expect(document.tables[0]?.title).toBe('Опыт');
    expect(document.createdAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('склеивает постраничный текст и выводит kind из MIME', () => {
    const document = normalizeParsedDocument({
      id: 'doc-2',
      filename: 'scan.png',
      mimeType: 'image/png',
      size: 10,
      pages: [{ text: 'Первая' }, { text: 'Вторая' }],
    });

    expect(document.kind).toBe('image');
    expect(document.text).toBe('Первая\n\nВторая');
    expect(document.createdAt).toBeNull();
  });

  it('таблице без колонок даёт нейтральную нумерацию', () => {
    const document = normalizeParsedDocument({
      id: 'doc-3',
      filename: 'table.pdf',
      mimeType: 'application/pdf',
      size: 10,
      text: '',
      tables: [
        {
          page: 1,
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      ],
    });

    expect(document.tables[0]?.columns).toEqual(['1', '2']);
    expect(document.tables[0]?.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('невалидный ответ бросает ZodError', () => {
    expect(() => normalizeParsedDocument({ id: 'doc-1' })).toThrow(ZodError);
  });
});

describe('classifyDocumentError', () => {
  function axiosError(status: number, data: unknown = {}): unknown {
    return Object.assign(new Error('request failed'), {
      isAxiosError: true,
      response: { status, data },
    });
  }

  it('404/405/501 — эндпоинт ещё не выкачен', () => {
    for (const status of [404, 405, 501]) {
      expect(classifyDocumentError(axiosError(status))).toBe('unavailable');
    }
  });

  it('413 и 415 различают размер и тип', () => {
    expect(classifyDocumentError(axiosError(413))).toBe('tooLarge');
    expect(classifyDocumentError(axiosError(415))).toBe('unsupportedType');
  });

  it('код ошибки API важнее статуса', () => {
    expect(
      classifyDocumentError(
        axiosError(400, { code: 'errors.document_too_large' }),
      ),
    ).toBe('tooLarge');
    expect(
      classifyDocumentError(
        axiosError(400, { code: 'errors.unsupported_document_type' }),
      ),
    ).toBe('unsupportedType');
  });

  it('без ответа — сеть, прочие ошибки — failed', () => {
    expect(
      classifyDocumentError(
        Object.assign(new Error('offline'), { isAxiosError: true }),
      ),
    ).toBe('network');
    expect(classifyDocumentError(new Error('boom'))).toBe('failed');
  });

  it('у каждой категории есть ключ i18n', () => {
    for (const kind of [
      'unavailable',
      'tooLarge',
      'unsupportedType',
      'network',
      'failed',
    ] as const) {
      expect(DOCUMENT_ERROR_KEYS[kind]).toMatch(/^chat\.upload\.errors\./);
    }
  });
});

describe('uploadDocument', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('отправляет файл multipart-ом и валидирует ответ', async () => {
    postMock.mockResolvedValueOnce({ data: DOCUMENT_RESPONSE });

    await expect(uploadDocument(createFile())).resolves.toMatchObject({
      id: 'doc-1',
      kind: 'pdf',
    });

    expect(postMock).toHaveBeenCalledTimes(1);

    const [url, body, config] = postMock.mock.calls[0] as [
      string,
      FormData,
      { headers: Record<string, string> },
    ];

    expect(url).toBe(DOCUMENTS_ENDPOINT);
    expect(body.get('file')).toBeInstanceOf(File);
    expect((body.get('file') as File).name).toBe('resume.pdf');
    expect(config.headers['Content-Type']).toBe('multipart/form-data');
  });

  it('сообщает прогресс через onUploadProgress', async () => {
    postMock.mockResolvedValueOnce({ data: DOCUMENT_RESPONSE });
    const onProgress = vi.fn();

    await uploadDocument(createFile(), { onProgress });

    const [, , config] = postMock.mock.calls[0] as [
      string,
      FormData,
      {
        onUploadProgress: (event: { loaded: number; total?: number }) => void;
      },
    ];

    config.onUploadProgress({ loaded: 25, total: 100 });
    expect(onProgress).toHaveBeenCalledWith(25);

    config.onUploadProgress({ loaded: 25, total: undefined });
    expect(onProgress).toHaveBeenCalledWith(null);
  });

  it('бросает ZodError, если ответ не по контракту', async () => {
    postMock.mockResolvedValueOnce({ data: { id: 'doc-1' } });

    await expect(uploadDocument(createFile())).rejects.toBeInstanceOf(ZodError);
  });
});

describe('documentToChatText', () => {
  it('склеивает текст и таблицы в Markdown', () => {
    const document = normalizeParsedDocument(DOCUMENT_RESPONSE);
    const text = documentToChatText(document);

    expect(text).toContain('Анна Петрова');
    expect(text).toContain('Опыт');
    expect(text).toContain('| Компания | Годы |');
    expect(text).toContain('| --- | --- |');
    expect(text).toContain('| Яндекс | 2021—2025 |');
  });

  it('пустой документ даёт пустую строку', () => {
    expect(
      documentToChatText(
        normalizeParsedDocument({
          id: 'doc-2',
          filename: 'empty.pdf',
          mimeType: 'application/pdf',
          size: 0,
          text: '   ',
        }),
      ),
    ).toBe('');
  });
});

describe('formatDocumentSize', () => {
  it('показывает байты, килобайты и мегабайты', () => {
    expect(formatDocumentSize(512)).toBe('512 Б');
    expect(formatDocumentSize(2048)).toBe('2 КБ');
    expect(formatDocumentSize(3 * 1024 * 1024)).toBe('3.0 МБ');
  });

  it('подставляет единицы из i18n', () => {
    expect(
      formatDocumentSize(3 * 1024 * 1024, {
        byte: 'B',
        kilobyte: 'KB',
        megabyte: 'MB',
      }),
    ).toBe('3.0 MB');
  });
});
