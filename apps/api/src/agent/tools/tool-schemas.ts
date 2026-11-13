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

/** Инструмент отправки сообщений в Telegram. */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';
export const SEND_MESSAGE_TOOL_DESCRIPTION =
  'Отправляет сообщение в Telegram через Bot API; можно приложить inline-кнопки с URL или callback_data';
export const SendMessageToolSchema = z.object({
  channel: z.string().describe('Канал: telegram (VK/WhatsApp ещё не подключены)'),
  to: z.string().describe('Получатель: chat_id или @username Telegram'),
  text: z.string().describe('Текст сообщения'),
  buttons: z
    .array(
      z
        .object({
          text: z.string().min(1).max(64).describe('Надпись на кнопке'),
          url: z.url().max(2_048).optional().describe('Ссылка кнопки'),
          callbackData: z
            .string()
            .min(1)
            .max(64)
            .optional()
            .describe('Данные callback-кнопки'),
        })
        .refine(
          (button) =>
            (button.url === undefined) !==
            (button.callbackData === undefined),
          'кнопка должна содержать ровно одно из полей url или callbackData',
        ),
    )
    .max(8)
    .optional()
    .describe('Inline-клавиатура: одна кнопка в ряд'),
});

/** Инструмент добавления строк в Google Sheets. */
export const GOOGLE_SHEETS_APPEND_TOOL_NAME = 'google_sheets_append';
export const GOOGLE_SHEETS_APPEND_TOOL_DESCRIPTION =
  'Добавляет строки в Google Таблицу через Sheets API v4 и возвращает обновлённый диапазон';
export const GoogleSheetsAppendToolSchema = z.object({
  sheetId: z.string().describe('Идентификатор таблицы (spreadsheetId)'),
  values: z.array(z.unknown()).describe('Строки для добавления'),
  range: z
    .string()
    .optional()
    .describe('Диапазон для append, по умолчанию A1'),
});

/** Инструмент создания Google Docs. */
export const GOOGLE_DOCS_CREATE_TOOL_NAME = 'google_docs_create';
export const GOOGLE_DOCS_CREATE_TOOL_DESCRIPTION =
  'Создаёт документ Google Docs через Docs API и вставляет текст, возвращает documentId и ссылку';
export const GoogleDocsCreateToolSchema = z.object({
  title: z.string().describe('Заголовок документа'),
  content: z.string().describe('Содержимое документа'),
});

/** Инструмент создания события Google Calendar. */
export const GOOGLE_CALENDAR_CREATE_TOOL_NAME = 'google_calendar_create';
export const GOOGLE_CALENDAR_CREATE_TOOL_DESCRIPTION =
  'Создаёт событие в Google Календаре (start/end в ISO 8601) и возвращает eventId и ссылку';
export const GoogleCalendarCreateToolSchema = z.object({
  summary: z.string().min(1).describe('Название события'),
  start: z.string().describe('Начало события, ISO 8601'),
  end: z.string().describe('Конец события, ISO 8601'),
  description: z.string().optional().describe('Описание события'),
  attendees: z
    .array(z.email())
    .optional()
    .describe('Email участников'),
  timeZone: z.string().optional().describe('Часовой пояс IANA'),
});

/** Инструмент генерации изображений Midjourney. */
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
export const GENERATE_IMAGE_TOOL_DESCRIPTION =
  'Генерирует изображение в Midjourney по промпту: отправляет задачу, дожидается готовности и возвращает URL картинки';
export const GenerateImageToolSchema = z.object({
  prompt: z.string().min(1).describe('Подробный промпт изображения'),
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

/** Инструмент юнит-экономики на реальных данных Ozon/WB. */
export const CALCULATE_UNIT_ECONOMICS_TOOL_NAME = 'calculate_unit_economics';
export const CALCULATE_UNIT_ECONOMICS_TOOL_DESCRIPTION =
  'Считает реальную юнит-экономику SKU по данным Ozon/WB MCP: выручка, комиссия, логистика, возвраты, штрафы и маржа за период';
export const CalculateUnitEconomicsToolSchema = z.object({
  sku: z.string().min(1).describe('SKU: offer_id (Ozon), nmId/vendorCode (WB)'),
  marketplace: z
    .enum(['ozon', 'wb'])
    .optional()
    .describe('Маркетплейс, по умолчанию ozon'),
  cost: z
    .number()
    .nonnegative()
    .optional()
    .describe('Себестоимость единицы, ₽ (если её нет в MCP)'),
  price: z
    .number()
    .nonnegative()
    .optional()
    .describe('Цена продажи, ₽ (переопределяет цену из MCP)'),
  dateFrom: z.string().optional().describe('Начало периода, YYYY-MM-DD'),
  dateTo: z.string().optional().describe('Конец периода, YYYY-MM-DD'),
  sellerId: z.string().optional().describe('shop_id продавца (мульти-магазин)'),
});

/** Инструмент поиска утечек прибыли на реальных данных MCP. */
export const DETECT_PROFIT_LEAKS_TOOL_NAME = 'detect_profit_leaks';
export const DETECT_PROFIT_LEAKS_TOOL_DESCRIPTION =
  'Ищет реальные утечки прибыли по данным Ozon/WB MCP: штрафы, удержания, возвраты, логистика, платное хранение и ценовой карантин';
export const DetectProfitLeaksToolSchema = z.object({
  sellerId: z.string().min(1).describe('Идентификатор продавца/shop_id'),
  marketplace: z
    .enum(['ozon', 'wb'])
    .optional()
    .describe('Маркетплейс, по умолчанию wb'),
  dateFrom: z.string().optional().describe('Начало периода, YYYY-MM-DD'),
  dateTo: z.string().optional().describe('Конец периода, YYYY-MM-DD'),
});

/** Инструмент мониторинга цен на реальных данных MCP. */
export const MONITOR_COMPETITOR_PRICES_TOOL_NAME = 'monitor_competitor_prices';
export const MONITOR_COMPETITOR_PRICES_TOOL_DESCRIPTION =
  'Сравнивает собственную цену SKU с ценой конкурента через Ozon Pricing API (для WB конкурентные цены MCP не отдаёт)';
export const MonitorCompetitorPricesToolSchema = z.object({
  sku: z.string().min(1).describe('SKU: offer_id/product_id (Ozon) или nmId (WB)'),
  marketplace: z
    .enum(['ozon', 'wb'])
    .optional()
    .describe('Маркетплейс, по умолчанию ozon'),
  productId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Ozon product_id для competitor pricing'),
  sellerId: z.string().optional().describe('shop_id продавца'),
});

/** Инструмент аудита рисков рекламной кампании на реальных данных MCP. */
export const AUDIT_FRAUD_RISK_TOOL_NAME = 'audit_fraud_risk';
export const AUDIT_FRAUD_RISK_TOOL_DESCRIPTION =
  'Проверяет рекламную кампанию по данным Ozon/WB MCP: наличие ERID/UTM, расход, удержания и антифрод-начисления';
export const AuditFraudRiskToolSchema = z.object({
  campaignId: z.string().min(1).describe('Идентификатор рекламной кампании'),
  marketplace: z
    .enum(['ozon', 'wb'])
    .optional()
    .describe('Маркетплейс, по умолчанию ozon'),
  dateFrom: z.string().optional().describe('Начало периода, YYYY-MM-DD'),
  dateTo: z.string().optional().describe('Конец периода, YYYY-MM-DD'),
  sellerId: z.string().optional().describe('shop_id продавца'),
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
  [GOOGLE_CALENDAR_CREATE_TOOL_NAME]: {
    description: GOOGLE_CALENDAR_CREATE_TOOL_DESCRIPTION,
    schema: GoogleCalendarCreateToolSchema,
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
