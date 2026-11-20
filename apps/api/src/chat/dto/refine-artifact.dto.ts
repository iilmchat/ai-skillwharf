import { z } from 'zod';

/** POST /chat/artifacts/refine (UX-37.1). */
export const refineArtifactRequestSchema = z
  .object({
    artifactType: z.enum(['document', 'table', 'code']),
    title: z.string().trim().min(1).max(200),
    fullContent: z.string().min(1).max(100_000),
    selectedText: z.string().min(1).max(20_000),
    instruction: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine((value) => value.fullContent.includes(value.selectedText), {
    message: 'selectedText должен быть фрагментом fullContent',
    path: ['selectedText'],
  });
export type RefineArtifactRequest = z.infer<typeof refineArtifactRequestSchema>;

export const refineArtifactResponseSchema = z
  .object({
    updatedContent: z.string().min(1),
    summary: z.string().min(1).max(1_000),
  })
  .strict();
export type RefineArtifactResponse = z.infer<
  typeof refineArtifactResponseSchema
>;

/** OpenAI-совместимый ответ чат-комплешена. */
export const chatCompletionResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});
