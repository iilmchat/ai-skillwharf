import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  KNOWLEDGE_DOCUMENTS_ENDPOINT,
  KNOWLEDGE_FOLDERS_ENDPOINT,
  TRANSCRIBE_ENDPOINT,
  createKnowledgeFolder,
  createKnowledgeFolderSchema,
  deleteKnowledgeFolder,
  fetchKnowledgeDocuments,
  fetchKnowledgeFolders,
  getKnowledgeErrorKind,
  knowledgeDocumentListSchema,
  knowledgeFolderListSchema,
  knowledgeDocumentsQueryKey,
  transcribeResponseSchema,
  transcribeVoiceAudio,
  uploadKnowledgeDocument,
} from './knowledge';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
}));

const FOLDER = { id: 'f1', name: 'Регламенты', documentCount: 2 };
const DOCUMENT = {
  id: 'd1',
  folderId: 'f1',
  title: 'Регламент приёмки',
  status: 'indexed',
  chunkCount: 4,
};

describe('Zod-схемы Базы знаний', () => {
  it('принимает списки папок и документов', () => {
    expect(
      knowledgeFolderListSchema.parse({ items: [FOLDER] }).items[0]?.name,
    ).toBe('Регламенты');
    expect(
      knowledgeDocumentListSchema.parse({ items: [DOCUMENT] }).items[0]?.status,
    ).toBe('indexed');
  });

  it('принимает папки голым массивом и нормализует документы API', () => {
    expect(knowledgeFolderListSchema.parse([FOLDER]).items).toEqual([FOLDER]);

    const parsed = knowledgeDocumentListSchema.parse({
      items: [
        {
          id: 'd3',
          folderId: null,
          documentTitle: 'Регламент приёмки',
          source: 'reglament.pdf',
          content: 'Проверка номенклатуры',
          pageNumber: 2,
          createdAt: '2026-11-20T10:00:00.000Z',
        },
      ],
    });

    expect(parsed.items[0]).toMatchObject({
      title: 'Регламент приёмки',
      fileName: 'reglament.pdf',
      snippet: 'Проверка номенклатуры',
      pageNumber: 2,
    });
  });

  it('заполняет статус по умолчанию и допускает nullable folderId', () => {
    const parsed = knowledgeDocumentListSchema.parse({
      items: [{ id: 'd2', title: 'Общий документ', folderId: null }],
    });

    expect(parsed.items[0]?.status).toBe('indexed');
    expect(parsed.items[0]?.folderId).toBeNull();
  });

  it('отклоняет невалидные данные', () => {
    expect(createKnowledgeFolderSchema.safeParse({ name: '  ' }).success).toBe(
      false,
    );
    expect(
      knowledgeFolderListSchema.safeParse({ items: [{ id: '', name: 'X' }] })
        .success,
    ).toBe(false);
    expect(
      knowledgeDocumentListSchema.safeParse({
        items: [{ ...DOCUMENT, status: 'unknown' }],
      }).success,
    ).toBe(false);
    expect(transcribeResponseSchema.safeParse({ text: 1 }).success).toBe(false);
  });
});

describe('API-клиент Базы знаний', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it('читает папки', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [FOLDER] } });

    await expect(fetchKnowledgeFolders()).resolves.toEqual({ items: [FOLDER] });
    expect(getMock).toHaveBeenCalledWith(KNOWLEDGE_FOLDERS_ENDPOINT);
  });

  it('создаёт и удаляет папку', async () => {
    postMock.mockResolvedValueOnce({ data: FOLDER });
    deleteMock.mockResolvedValueOnce({ data: '' });

    await expect(createKnowledgeFolder({ name: 'Регламенты' })).resolves.toEqual(
      FOLDER,
    );
    expect(postMock).toHaveBeenCalledWith(KNOWLEDGE_FOLDERS_ENDPOINT, {
      name: 'Регламенты',
    });

    await expect(deleteKnowledgeFolder('f/1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith(
      `${KNOWLEDGE_FOLDERS_ENDPOINT}/f%2F1`,
    );
  });

  it('не отправляет пустое название папки', async () => {
    await expect(createKnowledgeFolder({ name: ' ' })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  it('передаёт фильтр папки и поиск в query', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [DOCUMENT] } });

    await fetchKnowledgeDocuments({ folderId: 'f1', search: '  приёмка  ' });

    expect(getMock).toHaveBeenCalledWith(
      `${KNOWLEDGE_DOCUMENTS_ENDPOINT}?folderId=f1&search=%D0%BF%D1%80%D0%B8%D1%91%D0%BC%D0%BA%D0%B0`,
    );
    expect(knowledgeDocumentsQueryKey('f1', '')).toEqual([
      'knowledge',
      'documents',
      'f1',
      '',
    ]);
  });

  it('не добавляет query без фильтров', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [] } });

    await fetchKnowledgeDocuments();

    expect(getMock).toHaveBeenCalledWith(KNOWLEDGE_DOCUMENTS_ENDPOINT);
  });

  it('отбрасывает невалидный ответ API', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [{ id: '' }] } });

    await expect(fetchKnowledgeFolders()).rejects.toBeInstanceOf(ZodError);
  });

  it('загружает регламент multipart-формой', async () => {
    postMock.mockResolvedValueOnce({ data: DOCUMENT });
    const file = new File([new Uint8Array(4)], 'reglament.pdf', {
      type: 'application/pdf',
    });

    await expect(uploadKnowledgeDocument(file, 'f1')).resolves.toEqual(DOCUMENT);

    const [url, body, config] = postMock.mock.calls[0] ?? [];

    expect(url).toBe(KNOWLEDGE_DOCUMENTS_ENDPOINT);
    const uploaded = (body as FormData).get('file') as File;

    expect(uploaded.name).toBe('reglament.pdf');
    expect((body as FormData).get('folderId')).toBe('f1');
    expect(config).toEqual({
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  });
});

describe('transcribeVoiceAudio', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('отправляет Blob в поле audio и возвращает текст', async () => {
    postMock.mockResolvedValueOnce({ data: { text: 'Привет, мир' } });
    const blob = new Blob([new Uint8Array(2)], { type: 'audio/webm' });

    await expect(transcribeVoiceAudio(blob)).resolves.toEqual({
      text: 'Привет, мир',
    });
    expect(postMock).toHaveBeenCalledWith(
      TRANSCRIBE_ENDPOINT,
      expect.any(FormData),
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );

    const body = postMock.mock.calls[0]?.[1] as FormData;

    expect(body.get('audio')).toBeInstanceOf(Blob);
    expect((body.get('audio') as File).name).toBe('voice.webm');
  });

  it('проверяет ответ транскрибации', async () => {
    postMock.mockResolvedValueOnce({ data: {} });

    await expect(
      transcribeVoiceAudio(new Blob([new Uint8Array(1)])),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('getKnowledgeErrorKind', () => {
  it('различает ошибки контракта, сети и недоступности API', () => {
    expect(getKnowledgeErrorKind(new ZodError([]))).toBe('invalid');
    expect(getKnowledgeErrorKind({ name: 'AxiosError', response: undefined })).toBe(
      'unknown',
    );
    expect(
      getKnowledgeErrorKind({
        isAxiosError: true,
        response: { status: 404 },
      }),
    ).toBe('unavailable');
  });
});
