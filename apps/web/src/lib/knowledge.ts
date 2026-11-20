import { isAxiosError } from 'axios';
import { z } from 'zod';
import { api } from './api';

/**
 * Контракт Базы знаний и голосовой транскрибации (Sprint 38, KB-38.2/WEB-38.2).
 *
 * Ответы валидируются Zod: UI не должен показывать вымышленные папки или
 * документы, если API изменило формат. Необязательные поля терпимы к старым
 * ответам, у которых ещё нет счётчиков и дат.
 */
export const KNOWLEDGE_FOLDERS_ENDPOINT = '/knowledge/folders';
export const KNOWLEDGE_DOCUMENTS_ENDPOINT = '/knowledge/documents';
export const TRANSCRIBE_ENDPOINT = '/chat/transcribe';

const isoDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'ожидается дата в формате ISO 8601',
  });

export const knowledgeFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  documentCount: z.number().int().nonnegative().optional(),
  createdAt: isoDateSchema.optional(),
});

/**
 * API может вернуть как `{ items }`, так и голый массив: оба варианта
 * приводятся к одному виду для страницы.
 */
export const knowledgeFolderListSchema = z
  .union([
    z.array(knowledgeFolderSchema),
    z.object({ items: z.array(knowledgeFolderSchema) }),
  ])
  .transform((value) => (Array.isArray(value) ? { items: value } : value));

export const createKnowledgeFolderSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

/**
 * Фрагмент документа: API Sprint 38 отдаёт `documentTitle`/`source`/`content`,
 * а старые ответы — `title`/`fileName`/`snippet`. Оба вида нормализуются в
 * общую структуру, которую отображает страница.
 */
export const knowledgeDocumentSchema = z
  .object({
    id: z.string().min(1),
    folderId: z.string().nullable().optional(),
    title: z.string().min(1).optional(),
    documentTitle: z.string().min(1).nullable().optional(),
    fileName: z.string().optional(),
    source: z.string().nullable().optional(),
    status: z.enum(['indexed', 'processing', 'failed']).default('indexed'),
    chunkCount: z.number().int().nonnegative().optional(),
    snippet: z.string().optional(),
    content: z.string().optional(),
    pageNumber: z.number().int().nullable().optional(),
    createdAt: isoDateSchema.optional(),
  })
  .transform((wire) => ({
    id: wire.id,
    folderId: wire.folderId ?? null,
    title: wire.title ?? wire.documentTitle ?? wire.source ?? wire.id,
    fileName: wire.fileName ?? wire.source ?? undefined,
    status: wire.status,
    chunkCount: wire.chunkCount,
    snippet: wire.snippet ?? wire.content,
    pageNumber: wire.pageNumber ?? undefined,
    createdAt: wire.createdAt,
  }));

export const knowledgeDocumentListSchema = z.object({
  items: z.array(knowledgeDocumentSchema),
  total: z.number().int().nonnegative().optional(),
});

export const transcribeResponseSchema = z.object({
  text: z.string(),
});

export type KnowledgeFolder = z.infer<typeof knowledgeFolderSchema>;
export type KnowledgeFolderList = z.infer<typeof knowledgeFolderListSchema>;
export type CreateKnowledgeFolderPayload = z.infer<
  typeof createKnowledgeFolderSchema
>;
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeDocumentList = z.infer<typeof knowledgeDocumentListSchema>;
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>;

export const knowledgeFoldersQueryKey = ['knowledge', 'folders'] as const;

export function knowledgeDocumentsQueryKey(
  folderId: string | null,
  search: string,
): readonly ['knowledge', 'documents', string | null, string] {
  return ['knowledge', 'documents', folderId, search] as const;
}

export async function fetchKnowledgeFolders(): Promise<KnowledgeFolderList> {
  const { data } = await api.get<unknown>(KNOWLEDGE_FOLDERS_ENDPOINT);

  return knowledgeFolderListSchema.parse(data);
}

export async function createKnowledgeFolder(
  payload: CreateKnowledgeFolderPayload,
): Promise<KnowledgeFolder> {
  const request = createKnowledgeFolderSchema.parse(payload);
  const { data } = await api.post<unknown>(KNOWLEDGE_FOLDERS_ENDPOINT, request);

  return knowledgeFolderSchema.parse(data);
}

/** `DELETE` может вернуть 204 без тела — ответ намеренно не разбирается. */
export async function deleteKnowledgeFolder(id: string): Promise<void> {
  await api.delete(`${KNOWLEDGE_FOLDERS_ENDPOINT}/${encodeURIComponent(id)}`);
}

export interface KnowledgeDocumentParams {
  folderId?: string | null;
  search?: string;
}

export async function fetchKnowledgeDocuments(
  params: KnowledgeDocumentParams = {},
): Promise<KnowledgeDocumentList> {
  const query = new URLSearchParams();

  if (params.folderId !== undefined && params.folderId !== null && params.folderId !== '') {
    query.set('folderId', params.folderId);
  }

  if (params.search !== undefined && params.search.trim() !== '') {
    query.set('search', params.search.trim());
  }

  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  const { data } = await api.get<unknown>(
    `${KNOWLEDGE_DOCUMENTS_ENDPOINT}${suffix}`,
  );

  return knowledgeDocumentListSchema.parse(data);
}

/** Загрузка регламента в папку; `folderId` пустой — общая папка. */
export async function uploadKnowledgeDocument(
  file: File,
  folderId?: string | null,
): Promise<KnowledgeDocument> {
  const formData = new FormData();

  formData.append('file', file, file.name);

  if (folderId !== undefined && folderId !== null && folderId !== '') {
    formData.append('folderId', folderId);
  }

  const { data } = await api.post<unknown>(
    KNOWLEDGE_DOCUMENTS_ENDPOINT,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  );

  return knowledgeDocumentSchema.parse(data);
}

/** Аудио из MediaRecorder отправляется как multipart-поле `audio`. */
export async function transcribeVoiceAudio(
  blob: Blob,
): Promise<TranscribeResponse> {
  const formData = new FormData();

  formData.append('audio', blob, 'voice.webm');

  const { data } = await api.post<unknown>(TRANSCRIBE_ENDPOINT, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  return transcribeResponseSchema.parse(data);
}

/** Категория ошибки — страница и чат выбирают по ней локализованный текст. */
export type KnowledgeErrorKind =
  | 'network'
  | 'unavailable'
  | 'invalid'
  | 'unauthorized'
  | 'unknown';

export function getKnowledgeErrorKind(error: unknown): KnowledgeErrorKind {
  if (error instanceof z.ZodError) {
    return 'invalid';
  }

  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return 'network';
    }

    if (error.response.status === 401) {
      return 'unauthorized';
    }

    if (error.response.status === 404 || error.response.status === 501) {
      return 'unavailable';
    }
  }

  return 'unknown';
}
