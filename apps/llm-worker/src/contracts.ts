import { z } from 'zod';

/** Роль пользователя в policy engine API. */
export const userRoleSchema = z.enum(['guest', 'user', 'admin', 'owner']);

export type UserRole = z.infer<typeof userRoleSchema>;

/** Маршрут LLM, выбранный API-роутером. */
export const llmRouteSelectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  modelName: z.string(),
  providerType: z.string(),
  baseUrl: z.string(),
  apiKeyEnvVar: z.string().nullable(),
  taskType: z.string(),
  dailyCostLimit: z.number().nullable(),
});

export type LlmRouteSelection = z.infer<typeof llmRouteSelectionSchema>;

/** Сериализуемый снимок навыка: нужен только для skillId в OTel-логах. */
export const skillSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  manifest: z.unknown(),
  isEnabled: z.boolean(),
});

export type SkillSnapshot = z.infer<typeof skillSnapshotSchema>;

/** Контекст навыков по инструменту для policy engine API. */
export const toolSkillContextSchema = z.object({
  name: z.string(),
  permissions: z.array(
    z.enum(['network', 'filesystem', 'shell', 'secrets', 'hardware']),
  ),
  egressAllowlist: z.array(z.string()),
});

export type ToolSkillContext = z.infer<typeof toolSkillContextSchema>;

/** Цена Pay-per-Outcome по инструменту. */
export const outcomePriceSchema = z.object({
  price: z.number(),
  skillName: z.string(),
});

export type OutcomePrice = z.infer<typeof outcomePriceSchema>;

/** Описание инструмента, собранное API из манифестов навыков. */
export const toolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema аргументов; worker конвертирует его в Zod для LangChain. */
  parameters: z.record(z.string(), z.unknown()),
});

export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

/** Сообщение истории диалога, которое API отдаёт worker'у. */
export const historyMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

/** Контекст запуска графа; повторно передаётся при resume. */
export const graphContextSchema = z.object({
  conversationId: z.string().min(1),
  userId: z.string().min(1),
  skills: z.array(skillSnapshotSchema),
  approvalRequiredTools: z.array(z.string()),
  outcomePrices: z.record(z.string(), outcomePriceSchema),
  llmRoutes: z.array(llmRouteSelectionSchema),
  memoryContext: z.string(),
  userRole: userRoleSchema,
  toolSkills: z.record(z.string(), z.array(toolSkillContextSchema)),
  taintedSecrets: z.array(z.string()),
  systemPrompt: z.string(),
  tools: z.array(toolDescriptorSchema),
  agentId: z.string().optional(),
  skillId: z.string().optional(),
});

export type GraphContext = z.infer<typeof graphContextSchema>;

export const runGraphRequestSchema = graphContextSchema.extend({
  messages: z.array(historyMessageSchema),
});

export type RunGraphRequest = z.infer<typeof runGraphRequestSchema>;

export const resumeGraphRequestSchema = graphContextSchema.extend({
  approved: z.boolean(),
});

export type ResumeGraphRequest = z.infer<typeof resumeGraphRequestSchema>;

/** События NDJSON-стрима worker → API. */
export const deltaEventSchema = z.object({
  type: z.literal('delta'),
  text: z.string(),
});

export const officeEventSchema = z.object({
  type: z.literal('office'),
  conversationId: z.string(),
  agentId: z.string(),
  status: z.enum(['working', 'waiting_approval']),
  task: z.string(),
  reason: z.enum(['approval', 'payment']).optional(),
});

export const approvalEventSchema = z.object({
  type: z.literal('approval'),
  conversationId: z.string(),
  userId: z.string(),
  reason: z.enum(['approval', 'payment']),
  tools: z.array(z.string()),
  task: z.string(),
});

export const doneEventSchema = z.object({
  type: z.literal('done'),
  conversationId: z.string(),
  reply: z.string(),
  pendingApproval: z.boolean(),
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  statusCode: z.number().int().min(100).max(599),
  code: z.string().optional(),
  message: z.string(),
});

export const graphEventSchema = z.discriminatedUnion('type', [
  deltaEventSchema,
  officeEventSchema,
  approvalEventSchema,
  doneEventSchema,
  errorEventSchema,
]);

export type GraphEvent = z.infer<typeof graphEventSchema>;

/** Вызов инструмента моделью. */
export const agentToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});

export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

/** Инструмент, ожидающий подтверждения (подмножество graphContext). */
export const toolExecutionRequestSchema = z.object({
  conversationId: z.string().min(1),
  skills: z.array(skillSnapshotSchema),
  userId: z.string().min(1),
  userRole: userRoleSchema,
  toolSkills: z.record(z.string(), z.array(toolSkillContextSchema)),
  taintedSecrets: z.array(z.string()),
  outcomePrices: z.record(z.string(), outcomePriceSchema),
  calls: z.array(agentToolCallSchema),
  preAuthorizedHolds: z.record(z.string(), z.string()).default({}),
});

export type ToolExecutionRequest = z.infer<typeof toolExecutionRequestSchema>;

export const toolResultSchema = z.object({
  toolCallId: z.string(),
  name: z.string(),
  content: z.string(),
  status: z.enum(['success', 'error']).optional(),
});

export const toolExecutionResponseSchema = z.object({
  messages: z.array(toolResultSchema),
  taintedSecrets: z.array(z.string()),
});

export type ToolExecutionResponse = z.infer<
  typeof toolExecutionResponseSchema
>;

/** Подготовка HITL-ожидания: API проверяет политику и создаёт holds. */
export const approvalPrepareRequestSchema = z.object({
  conversationId: z.string().min(1),
  skills: z.array(skillSnapshotSchema),
  userId: z.string().min(1),
  userRole: userRoleSchema,
  toolSkills: z.record(z.string(), z.array(toolSkillContextSchema)),
  taintedSecrets: z.array(z.string()),
  outcomePrices: z.record(z.string(), outcomePriceSchema),
  calls: z.array(agentToolCallSchema),
});

export type ApprovalPrepareRequest = z.infer<
  typeof approvalPrepareRequestSchema
>;

export const approvalPrepareResponseSchema = z.object({
  reason: z.enum(['approval', 'payment']),
  tools: z.array(z.string()),
  holds: z.record(z.string(), z.string()),
});

export type ApprovalPrepareResponse = z.infer<
  typeof approvalPrepareResponseSchema
>;

export const approvalResolveRequestSchema = z.object({
  conversationId: z.string().min(1),
  approved: z.boolean(),
});

/** Учёт дневного бюджета: reserve/settle/refund в API. */
export const tokenUsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  total_tokens: z.number().int().min(0),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const budgetReserveRequestSchema = z.object({
  userId: z.string().min(1),
  estimatedPromptTokens: z.number().int().min(0),
});

export const budgetReserveResponseSchema = z.object({
  reserved: z.number().int().min(0),
  tracked: z.boolean(),
});

export type BudgetReservation = z.infer<
  typeof budgetReserveResponseSchema
>;

export const budgetRefundRequestSchema = z.object({
  userId: z.string().min(1),
  reserved: z.number().int().min(0),
});

export const budgetSettleRequestSchema = z.object({
  userId: z.string().min(1),
  reserved: z.number().int().min(0),
  usage: tokenUsageSchema,
  estimated: z.boolean(),
  route: llmRouteSelectionSchema.nullable(),
  agentId: z.string().optional(),
  skillId: z.string().optional(),
});

export type BudgetSettleRequest = z.infer<typeof budgetSettleRequestSchema>;

/** Checkpoint-операции worker → API (сериализация живёт в worker). */
export const checkpointGetRequestSchema = z.object({
  threadId: z.string().min(1),
  checkpointNs: z.string(),
  checkpointId: z.string().nullable(),
});

export const checkpointRecordSchema = z.object({
  config: z.object({
    configurable: z.record(z.string(), z.unknown()),
  }),
  checkpoint: z.string(),
  metadata: z.string(),
  parentConfig: z
    .object({ configurable: z.record(z.string(), z.unknown()) })
    .nullable()
    .optional(),
  pendingWrites: z.array(
    z.object({
      taskId: z.string(),
      channel: z.string(),
      value: z.string(),
    }),
  ),
});

export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;

export const checkpointPutRequestSchema = z.object({
  threadId: z.string().min(1),
  checkpointNs: z.string(),
  checkpointId: z.string().min(1),
  parentCheckpointId: z.string().nullable(),
  checkpoint: z.string(),
  metadata: z.string(),
});

export const checkpointWritesRequestSchema = z.object({
  threadId: z.string().min(1),
  checkpointNs: z.string(),
  checkpointId: z.string().min(1),
  taskId: z.string().min(1),
  taskPath: z.string(),
  writes: z.array(
    z.object({
      channel: z.string(),
      idx: z.number().int(),
      value: z.string(),
    }),
  ),
});

export const checkpointListRequestSchema = z.object({
  threadId: z.string().nullable(),
  checkpointNs: z.string().nullable(),
  before: z.string().nullable(),
  limit: z.number().int().min(0).nullable(),
  filter: z.record(z.string(), z.unknown()),
});

export const checkpointDeleteRequestSchema = z.object({
  threadId: z.string().min(1),
});

export const checkpointListResponseSchema = z.object({
  records: z.array(checkpointRecordSchema),
});
