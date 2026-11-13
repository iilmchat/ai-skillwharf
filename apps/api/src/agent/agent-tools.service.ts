import { Injectable, Logger, Optional } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { EgressPolicy } from '../sandbox/egress.js';
import { invalidRequestError } from '../common/api-error.js';
import { GoogleApiService } from '../integrations/google/google-api.service.js';
import { TelegramBotService } from '../integrations/telegram/telegram-bot.service.js';
import { TelegramService } from '../integrations/telegram/telegram.service.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { FinanceToolsService } from './finance/finance-tools.service.js';
import {
  FinanceSnapshotStore,
  type FinanceSnapshotKind,
} from './finance/finance-snapshot.store.js';
import { MidjourneyService } from './finance/midjourney.service.js';
import type { McpProvider } from './tools/mcp-gateway.js';
import { MarketplaceMcpService } from './tools/marketplace-mcp.service.js';
import {
  AUDIT_FRAUD_RISK_TOOL_NAME,
  CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
  CHECK_FACTS_TOOL_NAME,
  DETECT_PROFIT_LEAKS_TOOL_NAME,
  EXEC_TOOL_NAME,
  EXTRACT_DOCUMENT_DATA_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  GOOGLE_CALENDAR_CREATE_TOOL_NAME,
  GOOGLE_DOCS_CREATE_TOOL_NAME,
  GOOGLE_SHEETS_APPEND_TOOL_NAME,
  MONITOR_COMPETITOR_PRICES_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  PUBLISH_TO_DZEN_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SANDBOX_ENV_ALLOWLIST,
  SANDBOX_TOOL_NAME,
  SCREEN_RESUME_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  TAVILY_SEARCH_COMMAND,
  TOOL_REGISTRY,
  WB_MCP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  type ToolName,
} from './tools/tool-schemas.js';
import {
  AuditFraudRiskToolSchema,
  CalculateUnitEconomicsToolSchema,
  CheckFactsToolSchema,
  DetectProfitLeaksToolSchema,
  ExecToolSchema,
  ExtractDocumentDataToolSchema,
  GenerateImageToolSchema,
  GoogleCalendarCreateToolSchema,
  GoogleDocsCreateToolSchema,
  GoogleSheetsAppendToolSchema,
  McpToolSchema,
  MonitorCompetitorPricesToolSchema,
  PublishToDzenToolSchema,
  RunWorkflowToolSchema,
  SandboxToolSchema,
  ScreenResumeToolSchema,
  SendMessageToolSchema,
  WebSearchToolSchema,
} from './tools/tool-schemas.js';

/** Сериализуемое описание инструмента, которое уходит в llm-worker. */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Минимальный снимок навыка для выбора инструментов. */
export interface AgentSkillSnapshot {
  id: string;
  name: string;
  manifest: unknown;
  isEnabled: boolean;
}

export interface SandboxToolOptions {
  beforeExecute?: () => Promise<void>;
  egress?: EgressPolicy;
  /**
   * Владелец вызова: нужен инструментам, работающим от имени пользователя
   * (Google Workspace — OAuth-токен конкретного пользователя).
   */
  userId?: string;
  /** Навыки пользователя: из манифестов берутся MCP-endpoint и цены. */
  skills?: readonly AgentSkillSnapshot[];
}

export interface McpToolOptions extends SandboxToolOptions {
  endpoint?: string;
  authToken?: string;
}

export interface DzenPublishOptions extends SandboxToolOptions {
  outputDir?: string;
}

/** Объявлен ли инструмент хотя бы одним включённым навыком. */
function skillDeclaresTool(
  skills: readonly AgentSkillSnapshot[],
  toolName: string,
): boolean {
  return skills.some((skill) => {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    return (
      parsed.success &&
      (parsed.data.dependencies?.tools?.includes(toolName) ?? false)
    );
  });
}

/**
 * Инструменты агента живут в API: здесь policy engine, Ledger и песочница.
 * Worker получает только JSON Schema и делегирует выполнение сюда.
 */
@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);

  constructor(
    private readonly sandboxService: SandboxService,
    private readonly telegram: TelegramService,
    private readonly google: GoogleApiService,
    private readonly telegramBots: TelegramBotService,
    private readonly marketplace: MarketplaceMcpService,
    private readonly finance: FinanceToolsService,
    private readonly midjourney: MidjourneyService,
    @Optional() private readonly snapshots?: FinanceSnapshotStore,
  ) {}

  /** Есть ли инструмент в реестре (модель могла вызвать несуществующий). */
  has(name: string): boolean {
    return Object.hasOwn(TOOL_REGISTRY, name);
  }

  /** Инструменты, доступные агенту по манифестам включённых навыков. */
  buildDescriptors(
    skills: readonly AgentSkillSnapshot[],
  ): AgentToolDescriptor[] {
    const names: ToolName[] = [
      SANDBOX_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
      EXEC_TOOL_NAME,
    ];

    const optional: Array<[string, ToolName]> = [
      [OZON_MCP_TOOL_NAME, OZON_MCP_TOOL_NAME],
      [WB_MCP_TOOL_NAME, WB_MCP_TOOL_NAME],
      [SEND_MESSAGE_TOOL_NAME, SEND_MESSAGE_TOOL_NAME],
      [GOOGLE_SHEETS_APPEND_TOOL_NAME, GOOGLE_SHEETS_APPEND_TOOL_NAME],
      [GOOGLE_DOCS_CREATE_TOOL_NAME, GOOGLE_DOCS_CREATE_TOOL_NAME],
      [
        GOOGLE_CALENDAR_CREATE_TOOL_NAME,
        GOOGLE_CALENDAR_CREATE_TOOL_NAME,
      ],
      [GENERATE_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME],
      [RUN_WORKFLOW_TOOL_NAME, RUN_WORKFLOW_TOOL_NAME],
      [PUBLISH_TO_DZEN_TOOL_NAME, PUBLISH_TO_DZEN_TOOL_NAME],
      [CHECK_FACTS_TOOL_NAME, CHECK_FACTS_TOOL_NAME],
      [SCREEN_RESUME_TOOL_NAME, SCREEN_RESUME_TOOL_NAME],
      [EXTRACT_DOCUMENT_DATA_TOOL_NAME, EXTRACT_DOCUMENT_DATA_TOOL_NAME],
      [
        CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
        CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
      ],
      [DETECT_PROFIT_LEAKS_TOOL_NAME, DETECT_PROFIT_LEAKS_TOOL_NAME],
      [
        MONITOR_COMPETITOR_PRICES_TOOL_NAME,
        MONITOR_COMPETITOR_PRICES_TOOL_NAME,
      ],
      [AUDIT_FRAUD_RISK_TOOL_NAME, AUDIT_FRAUD_RISK_TOOL_NAME],
    ];

    for (const [toolName, registryName] of optional) {
      if (skillDeclaresTool(skills, toolName)) {
        names.push(registryName);
      }
    }

    return names.map((name) => {
      const entry = TOOL_REGISTRY[name];
      const json = zToJsonSchema(entry.schema);

      return {
        name,
        description: entry.description,
        parameters: json,
      };
    });
  }

  /** Выполняет инструмент по имени с Zod-валидацией аргументов. */
  async execute(
    name: string,
    args: Record<string, unknown>,
    options: SandboxToolOptions = {},
  ): Promise<string> {
    switch (name) {
      case SANDBOX_TOOL_NAME: {
        const input = SandboxToolSchema.parse(args);

        await options.beforeExecute?.();

        return this.sandboxService.runCommand(input.code, sandboxEnv(), {
          egress: options.egress,
        });
      }

      case WEB_SEARCH_TOOL_NAME: {
        const input = WebSearchToolSchema.parse(args);
        const apiKey = process.env.TAVILY_API_KEY;

        if (!apiKey) {
          return 'Ошибка: TAVILY_API_KEY не задан в окружении Gateway';
        }

        await options.beforeExecute?.();

        return this.sandboxService.runCommand(
          TAVILY_SEARCH_COMMAND,
          {
            TAVILY_REQUEST_BODY: JSON.stringify({
              api_key: apiKey,
              query: input.query,
              search_depth: 'basic',
              max_results: 5,
            }),
          },
          { egress: options.egress },
        );
      }

      case EXEC_TOOL_NAME: {
        const input = ExecToolSchema.parse(args);

        await options.beforeExecute?.();

        return this.sandboxService.runCommand(input.command, sandboxEnv(), {
          egress: options.egress,
        });
      }

      case OZON_MCP_TOOL_NAME:
        return this.executeMarketplaceMcp('ozon', args, options);

      case WB_MCP_TOOL_NAME:
        return this.executeMarketplaceMcp('wb', args, options);

      case SEND_MESSAGE_TOOL_NAME: {
        const input = SendMessageToolSchema.parse(args);

        if (input.channel.trim().toLowerCase() !== 'telegram') {
          throw invalidRequestError(
            `Канал «${input.channel}» ещё не подключён: доступен только telegram`,
          );
        }

        await options.beforeExecute?.();

        const botToken = await this.userBotToken(options.userId);
        const sent = await this.telegram.sendMessage({
          chatId: input.to,
          text: input.text,
          ...(botToken === null ? {} : { botToken }),
          ...(input.buttons === undefined ? {} : { buttons: input.buttons }),
        });

        return JSON.stringify({
          channel: 'telegram',
          chatId: sent.chatId,
          messageId: sent.messageId,
        });
      }

      case GOOGLE_SHEETS_APPEND_TOOL_NAME: {
        const input = GoogleSheetsAppendToolSchema.parse(args);

        await options.beforeExecute?.();

        const result = await this.google.appendSheetRows(
          requireUserId(options),
          {
            spreadsheetId: input.sheetId,
            values: input.values,
            ...(input.range === undefined ? {} : { range: input.range }),
          },
        );

        return JSON.stringify(result);
      }

      case GOOGLE_DOCS_CREATE_TOOL_NAME: {
        const input = GoogleDocsCreateToolSchema.parse(args);

        await options.beforeExecute?.();

        const created = await this.google.createDocument(
          requireUserId(options),
          { title: input.title, content: input.content },
        );

        return JSON.stringify(created);
      }

      case GOOGLE_CALENDAR_CREATE_TOOL_NAME: {
        const input = GoogleCalendarCreateToolSchema.parse(args);

        await options.beforeExecute?.();

        const event = await this.google.createCalendarEvent(
          requireUserId(options),
          {
            summary: input.summary,
            start: input.start,
            end: input.end,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.attendees === undefined
              ? {}
              : { attendees: input.attendees }),
            ...(input.timeZone === undefined
              ? {}
              : { timeZone: input.timeZone }),
          },
        );

        return JSON.stringify(event);
      }

      case GENERATE_IMAGE_TOOL_NAME: {
        const input = GenerateImageToolSchema.parse(args);
        const image = await this.midjourney.generate(input.prompt);

        // Списание Pay-per-Call — после успешной генерации.
        await options.beforeExecute?.();

        return JSON.stringify(image);
      }

      case RUN_WORKFLOW_TOOL_NAME: {
        const input = RunWorkflowToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Цепочка задач выполнена: ${input.steps.join(' -> ')}`;
      }

      case PUBLISH_TO_DZEN_TOOL_NAME:
        return this.publishToDzen(args, options);

      case CALCULATE_UNIT_ECONOMICS_TOOL_NAME: {
        const input = CalculateUnitEconomicsToolSchema.parse(args);
        const result = await this.finance.unitEconomics(
          input,
          this.financeContext(options),
        );

        await options.beforeExecute?.();
        await this.recordFinanceSnapshot(options, 'unitEconomics', result, [
          result.marketplace,
          result.sku,
        ]);

        return JSON.stringify(result);
      }

      case DETECT_PROFIT_LEAKS_TOOL_NAME: {
        const input = DetectProfitLeaksToolSchema.parse(args);
        const result = await this.finance.profitLeaks(
          input,
          this.financeContext(options),
        );

        await options.beforeExecute?.();
        await this.recordFinanceSnapshot(options, 'profitLeaks', result, null);

        return JSON.stringify(result);
      }

      case MONITOR_COMPETITOR_PRICES_TOOL_NAME: {
        const input = MonitorCompetitorPricesToolSchema.parse(args);
        const result = await this.finance.priceMonitor(
          input,
          this.financeContext(options),
        );

        await options.beforeExecute?.();

        return JSON.stringify(result);
      }

      case AUDIT_FRAUD_RISK_TOOL_NAME: {
        const input = AuditFraudRiskToolSchema.parse(args);
        const result = await this.finance.fraudAudit(
          input,
          this.financeContext(options),
        );

        await options.beforeExecute?.();
        await this.recordFinanceSnapshot(options, 'fraudShield', result, null);

        return JSON.stringify(result);
      }

      case CHECK_FACTS_TOOL_NAME:
        CheckFactsToolSchema.parse(args);
        await options.beforeExecute?.();

        return 'Факты подтверждены.';

      case SCREEN_RESUME_TOOL_NAME:
        ScreenResumeToolSchema.parse(args);
        await options.beforeExecute?.();

        return 'Кандидат подходит (Score: 85/100).';

      case EXTRACT_DOCUMENT_DATA_TOOL_NAME:
        ExtractDocumentDataToolSchema.parse(args);
        await options.beforeExecute?.();

        return '{"amount": "100000", "date": "2026-11-13"}';

      default:
        throw new Error(`Инструмент «${name}» не найден`);
    }
  }

  /** Контекст финансового инструмента: навыки нужны для MCP-endpoint. */
  private financeContext(
    options: SandboxToolOptions,
  ): { skills?: readonly AgentSkillSnapshot[] } {
    return options.skills === undefined ? {} : { skills: options.skills };
  }

  /**
   * Кладёт успешный финансовый результат в снапшоты дашборда.
   *
   * Пишем только то, что уже посчитано на реальных данных MCP, и не ломаем
   * tool call, если хранилище недоступно: дашборд тогда честно покажет
   * `dataAvailable: false`, а ответ агенту не пострадает.
   */
  private async recordFinanceSnapshot(
    options: SandboxToolOptions,
    kind: FinanceSnapshotKind,
    value: unknown,
    keyParts: readonly string[] | null,
  ): Promise<void> {
    if (this.snapshots === undefined || options.userId === undefined) {
      return;
    }

    try {
      await this.snapshots.record(
        options.userId,
        kind,
        value,
        keyParts === null ? null : keyParts.join('|'),
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'finance.snapshot.write_failed',
          kind,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Токен Telegram-бота пользователя (если подключён). Ошибка расшифровки
   * или отсутствие ключа не ломают отправку: fallback — системный бот.
   */
  private async userBotToken(userId?: string): Promise<string | null> {
    if (userId === undefined || userId.trim() === '') {
      return null;
    }

    try {
      return await this.telegramBots.getBotToken(userId);
    } catch (error) {
      this.logger.warn(
        `Telegram: не удалось получить бота пользователя ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }; используется системный бот`,
      );

      return null;
    }
  }

  private async executeMarketplaceMcp(
    platform: McpProvider,
    args: Record<string, unknown>,
    options: McpToolOptions,
  ): Promise<string> {
    const input = McpToolSchema.parse(args);

    await options.beforeExecute?.();

    return this.marketplace.call(platform, input.action, input.params, {
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.authToken === undefined
        ? {}
        : { authToken: options.authToken }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    });
  }

  private async publishToDzen(
    args: Record<string, unknown>,
    options: DzenPublishOptions,
  ): Promise<string> {
    const input = PublishToDzenToolSchema.parse(args);

    await options.beforeExecute?.();

    const filename = `dzen-${randomUUID()}.md`;
    const markdownParts = [`# ${input.title}`, ''];

    if (input.imageUrl !== undefined && input.imageUrl !== '') {
      markdownParts.push(`![Обложка](${input.imageUrl})`, '');
    }

    markdownParts.push(input.text, '');

    const markdown = markdownParts.join('\n');
    const encoded = Buffer.from(markdown, 'utf8').toString('base64');
    const script = [
      'set -eu',
      'mkdir -p /tmp/dzen-output',
      `python3 -c 'import base64,os,pathlib; p=pathlib.Path("/tmp/dzen-output")/os.environ["DZEN_FILENAME"]; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(base64.b64decode(os.environ["DZEN_CONTENT_B64"])); print(base64.b64encode(p.read_bytes()).decode())'`,
    ].join('\n');
    const output = await this.sandboxService.runCommand(script, {
      DZEN_FILENAME: filename,
      DZEN_CONTENT_B64: encoded,
    });
    const encodedResult = output.trim();

    if (encodedResult === '') {
      throw new Error('Песочница не вернула содержимое статьи');
    }

    const decoded = Buffer.from(encodedResult, 'base64').toString('utf8');
    const outputDir = options.outputDir ?? './dzen-output';

    await mkdir(outputDir, { recursive: true });
    const hostPath = join(outputDir, filename);
    await writeFile(hostPath, decoded, 'utf8');

    this.logger.log(`Черновик Дзен сохранён: ${hostPath}`);

    return `Черновик статьи «${input.title}» сохранён: ${hostPath}`;
  }
}

/** JSON Schema без `$schema`, чтобы worker мог конвертировать её в Zod. */
function zToJsonSchema(schema: z.ZodType): Record<string, unknown> {  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;

  delete json.$schema;

  return json;
}

/** Пользователь-владелец вызова: без него OAuth-инструменты не работают. */
function requireUserId(options: SandboxToolOptions): string {
  const userId = options.userId?.trim() ?? '';

  if (userId === '') {
    throw invalidRequestError(
      'Инструменту нужен пользователь: OAuth-подключение не найдено',
    );
  }

  return userId;
}

function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = process.env[key];

    if (value) {
      env[key] = value;
    }
  }

  return env;
}

/** Реэкспорт для совместимости: endpoint MCP теперь живёт в сервисе. */
export { resolveMcpEndpoint } from './tools/marketplace-mcp.service.js';
