import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ChatService } from '../chat/chat.service.js';
import {
  invalidRequestError,
  invalidTriggerSecretError,
} from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  createdTriggerViewSchema,
  createTriggerSchema,
  MAX_TRIGGER_PAYLOAD_BYTES,
  triggerPayloadSchema,
  triggerViewSchema,
  type CreatedTriggerView,
  type TriggerView,
} from './trigger.schemas.js';

/** Результат приёма вебхука: созданный/autonomous диалог. */
export interface TriggerReceiveResult {
  readonly accepted: true;
  readonly conversationId: string;
  readonly triggerId: string;
}

/**
 * Event-Driven агенты (CONNECT-32.2): входящие вебхуки запускают агента от
 * имени владельца триггера в его воркспейсе, без ручного ввода в чате.
 */
@Injectable()
export class TriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
  ) {}

  async list(workspaceId?: string): Promise<TriggerView[]> {
    const rows = await this.prisma.webhookTrigger.findMany({
      where: workspaceId === undefined ? {} : { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toView(row));
  }

  async create(
    userId: string,
    workspaceId: string,
    raw: unknown,
  ): Promise<CreatedTriggerView> {
    const input = createTriggerSchema.parse(raw ?? {});
    // hex вместо base64url: slug безопасен для URL и не содержит `_`/`~`.
    const slug = randomBytes(16).toString('hex').slice(0, 24);
    const secretToken = randomBytes(32).toString('base64url');
    const row = await this.prisma.webhookTrigger.create({
      data: {
        workspaceId,
        userId,
        name: input.name,
        slug,
        source: input.source,
        secretToken,
        promptTemplate: input.promptTemplate,
      },
    });

    return createdTriggerViewSchema.parse({
      ...toView(row),
      // Секрет отдаётся один раз при создании: UI показывает его и маскирует.
      secret: row.secretToken,
      webhookUrl: `/api/v1/webhooks/triggers/${row.slug}`,
    });
  }

  async remove(id: string, workspaceId?: string): Promise<{ deleted: boolean }> {
    const row = await this.prisma.webhookTrigger.findUnique({
      where: { id },
      select: { workspaceId: true },
    });

    if (row === null || (workspaceId !== undefined && row.workspaceId !== workspaceId)) {
      throw new NotFoundException('Триггер не найден');
    }

    await this.prisma.webhookTrigger.delete({ where: { id } });

    return { deleted: true };
  }

  /**
   * Публичный приём события: constant-time проверка секрета, лимит 32 КБ,
   * подстановка payload в шаблон и запуск автономного диалога.
   */
  async receive(
    slug: string,
    secretHeader: string | undefined,
    rawPayload: unknown,
  ): Promise<TriggerReceiveResult> {
    const trigger = await this.prisma.webhookTrigger.findUnique({
      where: { slug },
    });

    if (trigger === null || !trigger.isActive) {
      throw invalidTriggerSecretError('Триггер не найден или неактивен');
    }

    if (!secretMatches(secretHeader, trigger.secretToken)) {
      throw invalidTriggerSecretError('Неверный X-Trigger-Secret');
    }

    let serialized: string;

    try {
      serialized = JSON.stringify(rawPayload ?? {});
    } catch {
      throw invalidRequestError('Некорректный payload вебхука');
    }

    if (Buffer.byteLength(serialized, 'utf8') > MAX_TRIGGER_PAYLOAD_BYTES) {
      throw invalidRequestError('Payload вебхука превышает 32 КБ');
    }

    const parsed = triggerPayloadSchema.safeParse(JSON.parse(serialized));

    if (!parsed.success) {
      throw invalidRequestError('Payload вебхука должен быть JSON-объектом');
    }

    const prompt = trigger.promptTemplate
      .replaceAll('{{payload}}', serialized)
      .replaceAll('{{source}}', trigger.source)
      .slice(0, 64_000);

    const conversation = await this.prisma.conversation.create({
      data: {
        userId: trigger.userId,
        title: `Webhook: ${trigger.name}`.slice(0, 200),
      },
      select: { id: true },
    });
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: prompt,
      },
    });
    await this.prisma.webhookTrigger.update({
      where: { id: trigger.id },
      data: {
        lastTriggeredAt: new Date(),
        triggerCount: { increment: 1 },
      },
    });
    await this.chat.handleMessage(trigger.userId, conversation.id, prompt);

    return {
      accepted: true,
      conversationId: conversation.id,
      triggerId: trigger.id,
    };
  }
}

/** Приводит запись БД к контракту ответа API и Zod-схеме витрины. */
function toView(row: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  source: string;
  promptTemplate: string;
  isActive: boolean;
  lastTriggeredAt: Date | null;
  triggerCount: number;
  createdAt: Date;
}): TriggerView {
  return triggerViewSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    source: row.source,
    promptTemplate: row.promptTemplate,
    status: row.isActive ? 'active' : 'paused',
    isActive: row.isActive,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    triggerCount: row.triggerCount,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Сравнение секретов без раннего выхода (constant-time). */
export function secretMatches(
  provided: string | undefined,
  expected: string,
): boolean {
  if (provided === undefined) {
    return false;
  }

  const actualBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
