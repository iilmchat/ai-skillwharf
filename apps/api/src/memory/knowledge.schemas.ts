import { z } from 'zod';

/** POST /knowledge/folders. */
export const createKnowledgeFolderSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(1_000).optional(),
    workspaceId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type CreateKnowledgeFolderInput = z.infer<
  typeof createKnowledgeFolderSchema
>;

export const knowledgeFolderViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  chunkCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type KnowledgeFolderView = z.infer<typeof knowledgeFolderViewSchema>;

/** GET /knowledge/documents. */
export const knowledgeDocumentQuerySchema = z
  .object({
    folderId: z.string().trim().min(1).max(128).optional(),
    search: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
export type KnowledgeDocumentQuery = z.infer<
  typeof knowledgeDocumentQuerySchema
>;

export const knowledgeDocumentViewSchema = z.object({
  id: z.string(),
  folderId: z.string().nullable(),
  documentTitle: z.string().nullable(),
  source: z.string().nullable(),
  content: z.string(),
  pageNumber: z.number().int().nullable(),
  createdAt: z.string(),
});
export type KnowledgeDocumentView = z.infer<
  typeof knowledgeDocumentViewSchema
>;

export const knowledgeDocumentListSchema = z.object({
  items: z.array(knowledgeDocumentViewSchema),
  total: z.number().int().nonnegative(),
});
export type KnowledgeDocumentList = z.infer<
  typeof knowledgeDocumentListSchema
>;
