import { z } from 'zod';
import { mcpToolCallSchema } from './mcp-gateway.js';

/** Имя инструмента песочницы, которым LLM может вызвать выполнение кода. */
export const SANDBOX_TOOL_NAME = 'execute_sandbox_code';
export const SANDBOX_TOOL_DESCRIPTION =
  'Выполняет код на Python/Shell в изолированной среде и возвращает результат';
export const SandboxToolSchema = z.object({
  code: z.string().describe('Код для выполнения'),
});

/** Имя инструмента поиска в интернете. */
export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Ищет актуальную информацию в интернете через Tavily и возвращает результаты';
export const WebSearchToolSchema = z.object({
  query: z.string().describe('Поисковый запрос'),
});

/** Имя инструмента выполнения shell-команд. */
export const EXEC_TOOL_NAME = 'exec';
export const EXEC_TOOL_DESCRIPTION =
  'Выполняет shell-команду в изолированной среде и возвращает stdout';
export const ExecToolSchema = z.object({
  command: z.string().describe('Shell-команда для выполнения'),
});

/** MCP-инструменты маркетплейсов. */
export const OZON_MCP_TOOL_NAME = 'ozon_mcp_call';
export const OZON_MCP_TOOL_DESCRIPTION =
  'Вызывает реальный MCP-сервер Ozon Seller. Передайте имя MCP-инструмента в action (например, ozon_get_prices) и аргументы в params';
export const WB_MCP_TOOL_NAME = 'wb_mcp_call';
export const WB_MCP_TOOL_DESCRIPTION =
  'Вызывает реальный MCP-сервер Wildberries Seller. Передайте имя MCP-инструмента в action (например, wb_cards_list) и аргументы в params';
export const McpToolSchema = mcpToolCallSchema;

/** Mock-инструмент отправки сообщений. */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const SEND_MESSAGE_TOOL_DESCRIPTION =
  'Отправляет сообщение в Telegram/VK/WhatsApp (заглушка)';
export const SendMessageToolSchema = z.object({
  channel: z.string().describe('Канал: telegram, vk или whatsapp'),
  to: z.string().describe('Получатель сообщения'),
  text: z.string().describe('Текст сообщения'),
});

/** Mock-инструмент добавления строк в Google Sheets. */
export const GOOGLE_SHEETS_APPEND_TOOL_NAME = 'google_sheets_append';
export const GOOGLE_SHEETS_APPEND_TOOL_DESCRIPTION =
  'Добавляет строки в Google Таблицу (заглушка)';
export const GoogleSheetsAppendToolSchema = z.object({
  sheetId: z.string().describe('Идентификатор таблицы'),
  values: z.array(z.unknown()).describe('Строки для добавления'),
});

/** Mock-инструмент создания Google Docs. */
export const GOOGLE_DOCS_CREATE_TOOL_NAME = 'google_docs_create';
export const GOOGLE_DOCS_CREATE_TOOL_DESCRIPTION =
  'Создаёт документ Google Docs (заглушка)';
export const GoogleDocsCreateToolSchema = z.object({
  title: z.string().describe('Заголовок документа'),
  content: z.string().describe('Содержимое документа'),
});

/** Mock-инструмент генерации изображений. */
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const GENERATE_IMAGE_TOOL_DESCRIPTION =
  'Генерирует изображение по текстовому промпту (заглушка)';
export const GenerateImageToolSchema = z.object({
  prompt: z.string().describe('Текстовый промпт изображения'),
});

/** Mock-инструмент запуска цепочек задач. */
export const RUN_WORKFLOW_TOOL_NAME = 'run_workflow';
export const RUN_WORKFLOW_TOOL_DESCRIPTION =
  'Запускает многошаговую цепочку задач (заглушка)';
export const RunWorkflowToolSchema = z.object({
  steps: z.array(z.string()).describe('Шаги цепочки задач'),
});

/** Инструмент экспорта статьи для Дзен. */
export const PUBLISH_TO_DZEN_TOOL_NAME = 'publish_to_dzen';
export const PUBLISH_TO_DZEN_TOOL_DESCRIPTION =
  'Сохраняет черновик статьи для Дзен в Markdown и возвращает путь к файлу';
export const PublishToDzenToolSchema = z.object({
  title: z.string().describe('Заголовок статьи'),
  text: z.string().describe('Текст статьи'),
  imageUrl: z.string().optional().describe('URL обложки статьи'),
});

/** Mock-инструмент юнит-экономики. */
export const CALCULATE_UNIT_ECONOMICS_TOOL_NAME = 'calculate_unit_economics';
export const CALCULATE_UNIT_ECONOMICS_TOOL_DESCRIPTION =
  'Считает маржу по SKU (заглушка)';
export const CalculateUnitEconomicsToolSchema = z.object({
  sku: z.string().describe('Идентификатор товара'),
});

/** Mock-инструмент поиска утечек прибыли. */
export const DETECT_PROFIT_LEAKS_TOOL_NAME = 'detect_profit_leaks';
export const DETECT_PROFIT_LEAKS_TOOL_DESCRIPTION =
  'Ищет утечки прибыли по продавцу (заглушка)';
export const DetectProfitLeaksToolSchema = z.object({
  sellerId: z.string().describe('Идентификатор продавца'),
});

/** Mock-инструмент мониторинга цен конкурентов. */
export const MONITOR_COMPETITOR_PRICES_TOOL_NAME = 'monitor_competitor_prices';
export const MONITOR_COMPETITOR_PRICES_TOOL_DESCRIPTION =
  'Проверяет цены конкурентов по SKU (заглушка)';
export const MonitorCompetitorPricesToolSchema = z.object({
  sku: z.string().describe('Идентификатор товара'),
});

/** Mock-инструмент аудита рисков. */
export const AUDIT_FRAUD_RISK_TOOL_NAME = 'audit_fraud_risk';
export const AUDIT_FRAUD_RISK_TOOL_DESCRIPTION =
  'Проверяет доказательный пакет рекламной кампании (заглушка)';
export const AuditFraudRiskToolSchema = z.object({
  campaignId: z.string().describe('Идентификатор рекламной кампании'),
});

/** Mock-инструмент проверки фактов. */
export const CHECK_FACTS_TOOL_NAME = 'check_facts';
export const CHECK_FACTS_TOOL_DESCRIPTION =
  'Проверяет факты в тексте (заглушка)';
export const CheckFactsToolSchema = z.object({
  text: z.string().describe('Текст для проверки'),
});

/** Mock-инструмент скрининга резюме. */
export const SCREEN_RESUME_TOOL_NAME = 'screen_resume';
export const SCREEN_RESUME_TOOL_DESCRIPTION =
  'Оценивает резюме кандидата (заглушка)';
export const ScreenResumeToolSchema = z.object({
  resumeText: z.string().describe('Текст резюме'),
});

/** Mock-инструмент извлечения данных из документа. */
export const EXTRACT_DOCUMENT_DATA_TOOL_NAME = 'extract_document_data';
export const EXTRACT_DOCUMENT_DATA_TOOL_DESCRIPTION =
  'Извлекает сумму и дату из договора (заглушка)';
export const ExtractDocumentDataToolSchema = z.object({
  documentText: z.string().describe('Текст документа'),
});

/** Запрос к Tavily через песочницу. */
export const TAVILY_SEARCH_COMMAND =
  "curl -sS -X POST 'https://api.tavily.com/search' -H 'Content-Type: application/json' -d \"$TAVILY_REQUEST_BODY\"";

/** Секреты из окружения Gateway, которые разрешено передавать в песочницу. */
export const SANDBOX_ENV_ALLOWLIST = [
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
] as const;

/** Реестр описаний и схем инструментов для LLM. */
export const TOOL_REGISTRY = {
  [SANDBOX_TOOL_NAME]: {
    description: SANDBOX_TOOL_DESCRIPTION,
    schema: SandboxToolSchema,
  },
  [WEB_SEARCH_TOOL_NAME]: {
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    schema: WebSearchToolSchema,
  },
  [EXEC_TOOL_NAME]: {
    description: EXEC_TOOL_DESCRIPTION,
    schema: ExecToolSchema,
  },
  [OZON_MCP_TOOL_NAME]: {
    description: OZON_MCP_TOOL_DESCRIPTION,
    schema: McpToolSchema,
  },
  [WB_MCP_TOOL_NAME]: {
    description: WB_MCP_TOOL_DESCRIPTION,
    schema: McpToolSchema,
  },
  [SEND_MESSAGE_TOOL_NAME]: {
    description: SEND_MESSAGE_TOOL_DESCRIPTION,
    schema: SendMessageToolSchema,
  },
  [GOOGLE_SHEETS_APPEND_TOOL_NAME]: {
    description: GOOGLE_SHEETS_APPEND_TOOL_DESCRIPTION,
    schema: GoogleSheetsAppendToolSchema,
  },
  [GOOGLE_DOCS_CREATE_TOOL_NAME]: {
    description: GOOGLE_DOCS_CREATE_TOOL_DESCRIPTION,
    schema: GoogleDocsCreateToolSchema,
  },
  [GENERATE_IMAGE_TOOL_NAME]: {
    description: GENERATE_IMAGE_TOOL_DESCRIPTION,
    schema: GenerateImageToolSchema,
  },
  [RUN_WORKFLOW_TOOL_NAME]: {
    description: RUN_WORKFLOW_TOOL_DESCRIPTION,
    schema: RunWorkflowToolSchema,
  },
  [PUBLISH_TO_DZEN_TOOL_NAME]: {
    description: PUBLISH_TO_DZEN_TOOL_DESCRIPTION,
    schema: PublishToDzenToolSchema,
  },
  [CALCULATE_UNIT_ECONOMICS_TOOL_NAME]: {
    description: CALCULATE_UNIT_ECONOMICS_TOOL_DESCRIPTION,
    schema: CalculateUnitEconomicsToolSchema,
  },
  [DETECT_PROFIT_LEAKS_TOOL_NAME]: {
    description: DETECT_PROFIT_LEAKS_TOOL_DESCRIPTION,
    schema: DetectProfitLeaksToolSchema,
  },
  [MONITOR_COMPETITOR_PRICES_TOOL_NAME]: {
    description: MONITOR_COMPETITOR_PRICES_TOOL_DESCRIPTION,
    schema: MonitorCompetitorPricesToolSchema,
  },
  [AUDIT_FRAUD_RISK_TOOL_NAME]: {
    description: AUDIT_FRAUD_RISK_TOOL_DESCRIPTION,
    schema: AuditFraudRiskToolSchema,
  },
  [CHECK_FACTS_TOOL_NAME]: {
    description: CHECK_FACTS_TOOL_DESCRIPTION,
    schema: CheckFactsToolSchema,
  },
  [SCREEN_RESUME_TOOL_NAME]: {
    description: SCREEN_RESUME_TOOL_DESCRIPTION,
    schema: ScreenResumeToolSchema,
  },
  [EXTRACT_DOCUMENT_DATA_TOOL_NAME]: {
    description: EXTRACT_DOCUMENT_DATA_TOOL_DESCRIPTION,
    schema: ExtractDocumentDataToolSchema,
  },
} as const;

export type ToolName = keyof typeof TOOL_REGISTRY;
