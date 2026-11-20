import { z } from 'zod';
import { corpMessengerProviderSchema } from './adapters/corp-messenger.types.js';

const httpUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'apiBaseUrl должен использовать http/https',
  );

/** POST /workspaces/:workspaceId/channels/corporate. */
export const createCorpChannelSchema = z
  .object({
    provider: corpMessengerProviderSchema,
    name: z.string().trim().min(2).max(80),
    botToken: z.string().trim().min(1).max(256),
    apiBaseUrl: httpUrlSchema.optional(),
    allowedChatIds: z
      .array(z.union([z.string().min(1).max(64), z.number().int()]))
      .max(200)
      .optional(),
  })
  .strict();
export type CreateCorpChannelInput = z.infer<typeof createCorpChannelSchema>;

/** GET-ответ: открытый токен и секрет NEVER возвращаются. */
export const corpChannelViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  provider: corpMessengerProviderSchema,
  name: z.string(),
  apiBaseUrl: z.string().nullable(),
  tokenMasked: z.string(),
  webhookUrl: z.string(),
  allowedChatIds: z.array(z.string()),
  isActive: z.boolean(),
  lastMessageAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CorpChannelView = z.infer<typeof corpChannelViewSchema>;

export const createdCorpChannelSchema = corpChannelViewSchema.extend({
  webhookSecret: z.string().min(1),
});
export type CreatedCorpChannel = z.infer<typeof createdCorpChannelSchema>;
