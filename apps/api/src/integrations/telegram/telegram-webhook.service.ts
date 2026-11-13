import {
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import {
  invalidRequestError,
  providerNotConfiguredError,
} from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import { ChatService } from '../../chat/chat.service.js';
import { ApiException } from '../../common/api-error.js';
import { TelegramConfig } from './telegram.config.js';
import { TelegramLinkService } from './telegram-link.service.js';
import {
  messageText,
  normalizeChatId,
  telegramUpdateSchema,
} from './telegram.schemas.js';
import { TelegramService } from './telegram.service.js';

/** Окно rate limit для публичного webhook. */
export const TELEGRAM_WEBHOOK_TTL_MS = 60_000;

/** Подсказка для непривязанного чата. */
const UNLINKED_HINT =
  'Этот чат не привязан к SkillWharf. Откройте приложение → Настройки → Telegram и привяжите чат, затем повторите сообщение.';

/** Ответ на нажатие кнопки. */
const CALLBACK_ACK = 'Принято';

/** Лимит запросов webhook на IP за окно; настраивается env. */
export function resolveTelegramWebhookRateLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number.parseInt(env.TELEGRAM_WEBHOOK_RATE_LIMIT ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 120;
}

export const TELEGRAM_WEBHOOK_RATE_LIMIT =
  resolveTelegramWebhookRateLimit();

/**
 * Обработка входящих Telegram updates.
 *
 * Вынесено из контроллера, чтобы публичный alias `/webhooks/telegram` и
 * админский `/integrations/telegram/webhook` использовали одну и ту же
 * проверку секрета и маршрутизацию в ChatService.
 */
@Injectable()
export class TelegramWebhookService {
  private readonly logger = new Logger(TelegramWebhookService.name);
  private readonly config: TelegramConfig;

  constructor(
    private readonly telegram: TelegramService,
    private readonly links: TelegramLinkService,
    private readonly chatService: ChatService,
    @Optional() config?: TelegramConfig,
  ) {
    this.config = config ?? TelegramConfig.fromEnv();
  }

  /** Приём обновления. Всегда 200 для валидного update. */
  async handle(
    secret: string | undefined,
    body: unknown,
  ): Promise<{ ok: boolean }> {
    this.assertWebhookSecret(secret);

    const parsed = telegramUpdateSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError(
        `Telegram webhook: некорректный update (${parsed.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.join('.') || 'body')
          .join(', ')})`,
      );
    }

    const update = parsed.data;

    if (update.callback_query !== undefined) {
      await this.safeAnswerCallback(update.callback_query.id);

      return { ok: true };
    }

    const message = update.message ?? update.edited_message;

    if (message === undefined) {
      return { ok: true };
    }

    const text = messageText(message);
    const chatId = normalizeChatId(message.chat.id);

    if (text === null) {
      await this.safeSend(
        chatId,
        'Пока поддерживаются только текстовые сообщения.',
      );

      return { ok: true };
    }

    await this.handleMessage(chatId, text);

    return { ok: true };
  }

  /** Проверка секрета webhook (constant-time). */
  assertWebhookSecret(secret: string | undefined): void {
    const expected = this.config.webhookSecret;

    if (expected === null) {
      throw providerNotConfiguredError(
        'Telegram webhook не настроен: задайте TELEGRAM_WEBHOOK_SECRET',
      );
    }

    if (secret === undefined || !safeEqual(secret, expected)) {
      throw new UnauthorizedException('Неверный секрет Telegram webhook');
    }
  }

  /** Маршрутизация входящего сообщения в ChatService и ответ в чат. */
  private async handleMessage(chatId: string, text: string): Promise<void> {
    const link = await this.links.findByChatId(chatId);

    if (link === null) {
      await this.safeSend(chatId, UNLINKED_HINT);

      return;
    }

    try {
      const reply = await this.chatService.handleMessage(
        link.userId,
        link.conversationId,
        text,
      );

      if (reply.pendingApproval === true) {
        await this.safeSend(
          chatId,
          'Действие ожидает подтверждения: откройте SkillWharf, чтобы одобрить или отклонить его.',
        );

        return;
      }

      if (reply.reply.trim() !== '') {
        await this.safeSend(chatId, reply.reply);
      }

      return;
    } catch (error) {
      this.logger.error(
        `Telegram: не удалось обработать сообщение чата ${chatId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await this.safeSend(chatId, errorText(error));
    }
  }

  /** Отправка «best effort»: сбой Telegram не должен ломать webhook. */
  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.telegram.sendText(chatId, text);
    } catch (error) {
      this.logger.warn(
        `Telegram: не удалось отправить сообщение в ${chatId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async safeAnswerCallback(callbackQueryId: string): Promise<void> {
    try {
      await this.telegram.answerCallbackQuery(callbackQueryId, CALLBACK_ACK);
    } catch (error) {
      this.logger.warn(
        `Telegram: не удалось подтвердить callback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Сравнение строк за постоянное время (защита от timing-атак). */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/** Текст ошибки для пользователя Telegram по коду API. */
export function errorText(error: unknown): string {
  if (error instanceof ApiException) {
    const code = error.getResponse().code;

    switch (code) {
      case ERROR_KEYS.insufficientFunds:
        return 'Недостаточно средств на балансе SkillWharf.';
      case ERROR_KEYS.policyBlocked:
        return 'Действие заблокировано политикой безопасности.';
      case ERROR_KEYS.providerRateLimited:
        return 'Провайдер временно ограничил запросы. Попробуйте позже.';
      case ERROR_KEYS.providerAuthRequired:
        return 'Нужно заново подключить Google в настройках SkillWharf.';
      case ERROR_KEYS.outboundBlocked:
        return 'Внешний запрос заблокирован политикой безопасности.';
      default:
        return 'Не удалось обработать сообщение. Попробуйте позже.';
    }
  }

  return 'Не удалось обработать сообщение. Попробуйте позже.';
}
