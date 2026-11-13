import { Injectable, Logger, Optional } from '@nestjs/common';
import { providerNotConfiguredError } from '../../common/api-error.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../provider-http.js';
import { TelegramConfig } from './telegram.config.js';
import {
  normalizeChatId,
  telegramButtonsSchema,
  telegramGetMeSchema,
  telegramOkResultSchema,
  telegramSendMessageResultSchema,
  type TelegramButton,
} from './telegram.schemas.js';

/** Максимальная длина сообщения Telegram — 4096 символов. */
export const TELEGRAM_MESSAGE_LIMIT = 4_096;

/** Результат отправки сообщения. */
export interface TelegramSendResult {
  readonly messageId: number;
  readonly chatId: string;
}

/** Информация о боте (getMe). */
export interface TelegramBotInfo {
  readonly id: number;
  readonly username?: string;
  readonly name: string;
}

/** Параметры отправки сообщения. */
export interface TelegramSendInput {
  readonly chatId: string | number;
  readonly text: string;
  readonly buttons?: readonly TelegramButton[];
  /** Токен бота пользователя; без него используется системный бот. */
  readonly botToken?: string;
}

/**
 * Реальный клиент Telegram Bot API (messenger-connector).
 *
 * Все ответы валидируются Zod, повторы 429/5xx выполняет `providerRequest`.
 * Без `TELEGRAM_BOT_TOKEN` сервис не делает сетевых вызовов и отдаёт
 * `errors.provider_not_configured`.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly config: TelegramConfig;
  private readonly retry: ProviderRetryPolicy | undefined;

  constructor(
    @Optional() config?: TelegramConfig,
    @Optional() retry?: ProviderRetryPolicy,
  ) {
    this.config = config ?? TelegramConfig.fromEnv();
    this.retry = retry;
  }

  isConfigured(): boolean {
    return this.config.isConfigured();
  }

  /** Проверяет токен бота через getMe (для подключения из UI). */
  async getMe(botToken?: string): Promise<TelegramBotInfo> {
    const response = await providerRequest({
      provider: 'telegram',
      method: 'GET',
      url: this.methodUrl('getMe', botToken),
      schema: telegramGetMeSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });

    return {
      id: response.result.id,
      name: response.result.first_name,
      ...(response.result.username === undefined
        ? {}
        : { username: response.result.username }),
    };
  }

  /** Отправляет текст; при необходимости — с inline-клавиатурой. */
  async sendMessage(input: TelegramSendInput): Promise<TelegramSendResult> {
    const text = input.text.trim();

    if (text === '') {
      throw new Error('Telegram: пустой текст сообщения');
    }

    if (text.length > TELEGRAM_MESSAGE_LIMIT) {
      throw new Error(
        `Telegram: текст длиннее ${TELEGRAM_MESSAGE_LIMIT} символов`,
      );
    }

    const buttons = telegramButtonsSchema.parse(
      input.buttons === undefined ? undefined : [...input.buttons],
    );
    const data: Record<string, unknown> = {
      chat_id: normalizeChatId(input.chatId),
      text,
      // Предпросмотр ссылок в агентских сообщениях раздувает чат.
      disable_web_page_preview: true,
    };

    if (buttons !== undefined && buttons.length > 0) {
      data.reply_markup = {
        inline_keyboard: buttons.map((button) => [
          button.url === undefined
            ? { text: button.text, callback_data: button.callbackData }
            : { text: button.text, url: button.url },
        ]),
      };
    }

    const response = await providerRequest({
      provider: 'telegram',
      method: 'POST',
      url: this.methodUrl('sendMessage', input.botToken),
      data,
      schema: telegramSendMessageResultSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });

    return {
      messageId: response.result.message_id,
      chatId: normalizeChatId(response.result.chat.id),
    };
  }

  /**
   * Отправляет длинный текст несколькими сообщениями (ответ агента может
   * превышать лимит Telegram). Возвращает id последнего сообщения.
   */
  async sendText(
    chatId: string | number,
    text: string,
    options: { buttons?: readonly TelegramButton[]; botToken?: string } = {},
  ): Promise<TelegramSendResult> {
    const parts = splitTelegramText(text, TELEGRAM_MESSAGE_LIMIT - 96);
    let last: TelegramSendResult | null = null;

    for (const [index, part] of parts.entries()) {
      last = await this.sendMessage({
        chatId,
        text: part,
        ...(options.botToken === undefined
          ? {}
          : { botToken: options.botToken }),
        ...(index === parts.length - 1 && options.buttons !== undefined
          ? { buttons: options.buttons }
          : {}),
      });
    }

    if (last === null) {
      throw new Error('Telegram: нечего отправлять');
    }

    return last;
  }

  /** Подтверждает нажатие inline-кнопки, чтобы у клиента убрался «часик». */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    await providerRequest({
      provider: 'telegram',
      method: 'POST',
      url: this.methodUrl('answerCallbackQuery'),
      data: {
        callback_query_id: callbackQueryId,
        ...(text === undefined || text === '' ? {} : { text }),
      },
      schema: telegramOkResultSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });
  }

  /** Регистрирует webhook в Telegram (админ-операция при деплое). */
  async setWebhook(publicUrl: string, secret?: string): Promise<void> {
    await providerRequest({
      provider: 'telegram',
      method: 'POST',
      url: this.methodUrl('setWebhook'),
      data: {
        url: publicUrl,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
        ...(secret === undefined || secret === ''
          ? {}
          : { secret_token: secret }),
      },
      schema: telegramOkResultSchema,
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      logger: this.logger,
    });
  }

  private methodUrl(method: string, botToken?: string): string {
    const token = botToken?.trim() || this.config.botToken;

    if (token === null || token === '') {
      throw providerNotConfiguredError(
        'Telegram не настроен: задайте TELEGRAM_BOT_TOKEN или подключите бота',
      );
    }

    return `${this.config.apiBaseUrl}/bot${token}/${method}`;
  }
}

/**
 * Режет текст по границам строк/слов так, чтобы каждая часть влезала в лимит.
 * Пустые строки не отбрасываются: форматирование Markdown сохраняется.
 */
export function splitTelegramText(
  text: string,
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();

  if (normalized === '') {
    return [];
  }

  if (normalized.length <= limit) {
    return [normalized];
  }

  const parts: string[] = [];
  let current = '';

  for (const line of normalized.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current !== '') {
      parts.push(current);
      current = '';
    }

    if (line.length <= limit) {
      current = line;
      continue;
    }

    // Строка-«монстр»: режем по словам, затем жёстко по символам.
    for (const chunk of splitLongLine(line, limit)) {
      parts.push(chunk);
    }
  }

  if (current !== '') {
    parts.push(current);
  }

  return parts;
}

function splitLongLine(line: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = line;

  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    const breakAt = Math.max(
      slice.lastIndexOf(' '),
      slice.lastIndexOf('\t'),
    );
    const cut = breakAt > 0 ? breakAt : limit;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest !== '') {
    chunks.push(rest);
  }

  return chunks;
}
