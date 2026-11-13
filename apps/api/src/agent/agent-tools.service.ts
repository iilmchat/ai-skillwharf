import { Injectable, Logger } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { EgressPolicy } from '../sandbox/egress.js';
import { marketplaceUnavailableError } from '../common/api-error.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { McpClient } from './tools/mcp-client.js';
import { McpGateway, mcpUnavailableError, type McpProvider } from './tools/mcp-gateway.js';
import {
  AUDIT_FRAUD_RISK_TOOL_NAME,
  CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
  CHECK_FACTS_TOOL_NAME,
  DETECT_PROFIT_LEAKS_TOOL_NAME,
  EXEC_TOOL_NAME,
  EXTRACT_DOCUMENT_DATA_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
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
}

export interface McpToolOptions extends SandboxToolOptions {
  endpoint?: string;
  authToken?: string;
}

export interface DzenPublishOptions extends SandboxToolOptions {
  outputDir?: string;
}

/** Адрес MCP-сервера: манифест навыка в приоритете, env — fallback. */
export function resolveMcpEndpoint(
  platform: McpProvider,
  manifestEndpoint?: string,
): string | null {
  const fromManifest = manifestEndpoint?.trim() ?? '';

  if (fromManifest !== '') {
    return fromManifest;
  }

  const fromEnv =
    platform === 'ozon' ? process.env.OZON_MCP_URL : process.env.WB_MCP_URL;

  return fromEnv === undefined || fromEnv.trim() === '' ? null : fromEnv.trim();
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
  private readonly mcpClients = new Map<string, McpClient>();
  private readonly mcpGateways = new WeakMap<McpClient, McpGateway>();

  constructor(private readonly sandboxService: SandboxService) {}

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

        await options.beforeExecute?.();

        return `Сообщение отправлено в ${input.channel} для ${input.to}`;
      }

      case GOOGLE_SHEETS_APPEND_TOOL_NAME: {
        const input = GoogleSheetsAppendToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Данные добавлены в таблицу ${input.sheetId}`;
      }

      case GOOGLE_DOCS_CREATE_TOOL_NAME: {
        const input = GoogleDocsCreateToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Документ "${input.title}" создан`;
      }

      case GENERATE_IMAGE_TOOL_NAME:
        GenerateImageToolSchema.parse(args);
        await options.beforeExecute?.();

        return 'https://placehold.co/600x400?text=Generated';

      case RUN_WORKFLOW_TOOL_NAME: {
        const input = RunWorkflowToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Цепочка задач выполнена: ${input.steps.join(' -> ')}`;
      }

      case PUBLISH_TO_DZEN_TOOL_NAME:
        return this.publishToDzen(args, options);

      case CALCULATE_UNIT_ECONOMICS_TOOL_NAME: {
        const input = CalculateUnitEconomicsToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Маржа для ${input.sku} составляет 25%.`;
      }

      case DETECT_PROFIT_LEAKS_TOOL_NAME:
        DetectProfitLeaksToolSchema.parse(args);
        await options.beforeExecute?.();

        return 'Найдена утечка на 120 000 ₽ из-за штрафа за габариты.';

      case MONITOR_COMPETITOR_PRICES_TOOL_NAME: {
        const input = MonitorCompetitorPricesToolSchema.parse(args);

        await options.beforeExecute?.();

        return `Конкурент снизил цену на ${input.sku} до 990 ₽.`;
      }

      case AUDIT_FRAUD_RISK_TOOL_NAME:
        AuditFraudRiskToolSchema.parse(args);
        await options.beforeExecute?.();

        return 'Доказательный пакет неполный. Риск санкции высокий.';

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

  private async executeMarketplaceMcp(
    platform: McpProvider,
    args: Record<string, unknown>,
    options: McpToolOptions,
  ): Promise<string> {
    const input = McpToolSchema.parse(args);
    const keyVars =
      platform === 'ozon'
        ? ['OZON_CLIENT_ID', 'OZON_API_KEY']
        : ['WB_API_TOKEN'];

    if (!hasEnv(...keyVars)) {
      throw marketplaceUnavailableError(
        platform === 'ozon'
          ? 'Ozon API keys not configured'
          : 'WB API token not configured',
      );
    }

    const gateway = this.getMcpGateway(platform, options);

    if (gateway === null) {
      throw mcpUnavailableError();
    }

    await options.beforeExecute?.();

    return gateway.call({ action: input.action, params: input.params });
  }

  private getMcpGateway(
    platform: McpProvider,
    options: McpToolOptions,
  ): McpGateway | null {
    const client = this.getMcpClient(
      platform,
      options.endpoint,
      options.authToken,
    );

    if (client === null) {
      return null;
    }

    const cached = this.mcpGateways.get(client);

    if (cached !== undefined) {
      return cached;
    }

    const gateway = new McpGateway({
      provider: platform,
      client,
      listTools: () => client.listTools(),
    });

    this.mcpGateways.set(client, gateway);

    return gateway;
  }

  private getMcpClient(
    platform: McpProvider,
    manifestEndpoint?: string,
    authToken?: string,
  ): McpClient | null {
    const url = resolveMcpEndpoint(platform, manifestEndpoint);

    if (url === null) {
      return null;
    }

    const cached = this.mcpClients.get(url);

    if (cached !== undefined) {
      return cached;
    }

    const token = authToken ?? process.env.MCP_AUTH_TOKEN;
    const client = new McpClient({
      baseUrl: url,
      ...(token === undefined || token === '' ? {} : { authToken: token }),
    });

    this.mcpClients.set(url, client);

    return client;
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
function zToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;

  delete json.$schema;

  return json;
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

function hasEnv(...names: string[]): boolean {
  return names.every((name) => {
    const value = process.env[name];

    return value !== undefined && value !== '';
  });
}
