import {
  KNOWN_TOOL_NAMES,
  TOOL_POLICIES,
  approvalRuleFor,
  approvalRuleMatches,
  getToolPolicy,
  requiresApprovalFor,
} from './tool-policies.js';

/** Валидные аргументы для каждого инструмента из tool-schemas.ts. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  execute_sandbox_code: { code: 'echo ok' },
  web_search: { query: 'погода в Москве' },
  exec: { command: 'gh --version' },
  ozon_mcp_call: { action: 'ozon_get_prices', params: { sku: ['1'] } },
  wb_mcp_call: { action: 'wb_cards_list', params: { limit: 10 } },
  bitrix24_get_deal: { dealId: '42' },
  bitrix24_update_deal: { dealId: '42', stageId: 'WON', comments: 'Готово' },
  moysklad_check_stock: { productId: 'product-1', quantity: 9 },
  moysklad_get_cost: { productId: 'product-1' },
  moysklad_create_order: {
    dealId: '42',
    items: [{ productId: 'product-1', quantity: 2 }],
  },
  send_message: {
    channel: 'telegram',
    to: '@user',
    text: 'привет',
    buttons: [{ text: 'Открыть', url: 'https://example.com' }],
  },
  google_sheets_append: {
    sheetId: 'sheet-1',
    values: [['a', 1, true], ['b']],
  },
  google_docs_create: { title: 'Документ', content: 'Текст' },
  google_calendar_create: {
    summary: 'Встреча',
    start: '2026-11-20T10:00:00Z',
    end: '2026-11-20T11:00:00Z',
  },
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
  extract_pdf: { path: 'contract.pdf' },
  write_docx: {
    title: 'Отчёт',
    blocks: [{ type: 'paragraph', text: 'Текст' }],
  },
  ocr_document: { path: 'scan.png', language: 'ru' },
  onec_search_nomenclature: { query: ' SKU-1 ' },
  onec_check_stock: { nomenclatureId: 'nom-1' },
  onec_check_debt: { counterpartyId: 'cp-1' },
  onec_create_order: {
    counterpartyId: 'cp-1',
    items: [{ nomenclatureId: 'nom-1', quantity: 2 }],
  },
  edo_list_incoming_upd: { provider: 'diadoc', limit: 5 },
  edo_get_document_details: { provider: 'sbis', documentId: 'doc-1' },
  edo_reconcile_with_erp: {
    provider: 'diadoc',
    documentId: 'doc-1',
    orderItems: [{ name: 'Болт', quantity: 1, priceRub: 10 }],
  },
  edo_prepare_sign_packet: {
    provider: 'diadoc',
    documentIds: ['doc-1'],
    signer: 'Иванов И.И.',
  },
};

const TOOL_NAMES = Object.keys(VALID_ARGS);

describe('tool-policies', () => {
  it('покрывает политикой все инструменты из tool-schemas.ts', () => {
    expect(TOOL_NAMES).toHaveLength(35);
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
      requiredPermission: null,
      taint: 'block',
      egress: 'none',
    });
    expect(TOOL_POLICIES.calculate_unit_economics.taint).toBe('block');
  });

  it('объявляет HITL для необратимых действий CRM и склада', () => {
    expect(TOOL_POLICIES.bitrix24_update_deal.approval).toBe('final-stage');
    expect(TOOL_POLICIES.moysklad_create_order.approval).toBe('always');
    // Читающие инструменты навыка не должны останавливать граф.
    expect(TOOL_POLICIES.bitrix24_get_deal.approval).toBe('none');
    expect(TOOL_POLICIES.moysklad_check_stock.approval).toBe('none');
    expect(TOOL_POLICIES.moysklad_get_cost.approval).toBe('none');
  });

  it('требует подтверждения только для финальной стадии сделки', () => {
    expect(
      requiresApprovalFor('bitrix24_update_deal', {
        dealId: '42',
        stageId: 'WON',
      }),
    ).toBe(true);
    expect(
      requiresApprovalFor('bitrix24_update_deal', {
        dealId: '42',
        stageId: 'C1:WON',
      }),
    ).toBe(true);
    expect(
      requiresApprovalFor('bitrix24_update_deal', {
        dealId: '42',
        stageId: 'EXECUTING',
      }),
    ).toBe(false);
    expect(
      requiresApprovalFor('bitrix24_update_deal', {
        dealId: '42',
        comments: 'Только комментарий',
      }),
    ).toBe(false);
  });

  it('отдаёт правило HITL по аргументу для bitrix24_update_deal (KI-079)', () => {
    expect(approvalRuleFor('bitrix24_update_deal')).toEqual({
      tool: 'bitrix24_update_deal',
      arg: 'stageId',
      values: ['WON'],
    });
    expect(approvalRuleFor('moysklad_create_order')).toBeNull();
    expect(approvalRuleFor('unknown_tool')).toBeNull();

    expect(approvalRuleMatches('WON', ['WON'])).toBe(true);
    expect(approvalRuleMatches('c1:won', ['WON'])).toBe(true);
    expect(approvalRuleMatches('EXECUTING', ['WON'])).toBe(false);
    expect(approvalRuleMatches(undefined, ['WON'])).toBe(false);
  });

  it('требует подтверждения для создания заказа и не требует для чтения', () => {
    expect(
      requiresApprovalFor('moysklad_create_order', {
        dealId: '42',
        items: [{ productId: 'product-1', quantity: 1 }],
      }),
    ).toBe(true);
    expect(requiresApprovalFor('bitrix24_get_deal', { dealId: '42' })).toBe(
      false,
    );
    expect(
      requiresApprovalFor('moysklad_check_stock', {
        productId: 'product-1',
        quantity: 1,
      }),
    ).toBe(false);
    expect(requiresApprovalFor('unknown_tool', {})).toBe(false);
  });
});
