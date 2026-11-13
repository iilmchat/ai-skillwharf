import {
  KNOWN_TOOL_NAMES,
  TOOL_POLICIES,
  getToolPolicy,
} from './tool-policies.js';

/** Валидные аргументы для каждого инструмента из llm.service.ts. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  execute_sandbox_code: { code: 'echo ok' },
  web_search: { query: 'погода в Москве' },
  exec: { command: 'gh --version' },
  ozon_mcp_call: { action: 'ozon_get_prices', params: { sku: ['1'] } },
  wb_mcp_call: { action: 'wb_cards_list', params: { limit: 10 } },
  send_message: { channel: 'telegram', to: '@user', text: 'привет' },
  google_sheets_append: {
    sheetId: 'sheet-1',
    values: [['a', 1, true], ['b']],
  },
  google_docs_create: { title: 'Документ', content: 'Текст' },
  generate_image: { prompt: 'кот в космосе' },
  run_workflow: { steps: ['собрать данные', 'посчитать'] },
  publish_to_dzen: {
    title: 'Статья',
    text: 'Текст статьи',
    imageUrl: 'https://example.com/cover.png',
  },
  calculate_unit_economics: { sku: 'SKU-1' },
  detect_profit_leaks: { sellerId: 'seller-1' },
  monitor_competitor_prices: { sku: 'SKU-1' },
  audit_fraud_risk: { campaignId: 'campaign-1' },
  check_facts: { text: 'Земля круглая' },
  screen_resume: { resumeText: 'Опыт работы: 5 лет' },
  extract_document_data: { documentText: 'Договор на 100000 рублей' },
};

const TOOL_NAMES = Object.keys(VALID_ARGS);

describe('tool-policies', () => {
  it('покрывает политикой все инструменты из llm.service.ts', () => {
    expect(TOOL_NAMES).toHaveLength(18);
    expect([...KNOWN_TOOL_NAMES].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('не знает неизвестный инструмент', () => {
    expect(getToolPolicy('drop_database')).toBeUndefined();
  });

  it.each(TOOL_NAMES)('принимает валидные аргументы %s', (toolName) => {
    const policy = TOOL_POLICIES[toolName];

    expect(policy).toBeDefined();

    const parsed = policy.schema.safeParse(VALID_ARGS[toolName]);

    expect(parsed.success).toBe(true);
  });

  it.each(TOOL_NAMES)('запрещает лишние ключи %s', (toolName) => {
    const policy = TOOL_POLICIES[toolName];

    const parsed = policy.schema.safeParse({
      ...VALID_ARGS[toolName],
      extraKey: 'лишний',
    });

    expect(parsed.success).toBe(false);
  });

  it('отклоняет неверные типы и слишком длинные строки', () => {
    expect(
      TOOL_POLICIES.web_search.schema.safeParse({ query: 42 }).success,
    ).toBe(false);
    expect(
      TOOL_POLICIES.exec.schema.safeParse({ command: 'a'.repeat(2_001) })
        .success,
    ).toBe(false);
    expect(
      TOOL_POLICIES.run_workflow.schema.safeParse({ steps: [] }).success,
    ).toBe(false);
    expect(
      TOOL_POLICIES.send_message.schema.safeParse({
        channel: 'pigeon',
        to: 'x',
        text: 'y',
      }).success,
    ).toBe(false);
  });

  it('фиксирует разрешения, egress и taint для ключевых инструментов', () => {
    expect(TOOL_POLICIES.execute_sandbox_code).toMatchObject({
      requiredPermission: 'shell',
      egress: 'sandbox-network',
      taint: 'block',
      shell: 'sandbox',
    });
    expect(TOOL_POLICIES.exec).toMatchObject({
      requiredPermission: 'shell',
      taint: 'block',
      shell: 'exec',
    });
    expect(TOOL_POLICIES.web_search).toMatchObject({
      requiredPermission: 'network',
      taint: 'mask',
      egressRequested: true,
    });
    expect(TOOL_POLICIES.ozon_mcp_call).toMatchObject({
      requiredPermission: 'network',
      taint: 'block',
      egress: 'gateway-network',
    });
    expect(TOOL_POLICIES.calculate_unit_economics.taint).toBe('none');
  });
});
