import { describe, expect, it, vi } from 'vitest';
import {
  buildLeadMailto,
  buildLeadWebhookPayload,
  designPartnerSchema,
  formatLeadMessage,
  isSupportedContact,
  submitLeadToWebhook,
  type DesignPartnerLead,
  type LeadMessageLabels,
} from './design-partner';

const LABELS: LeadMessageLabels = {
  title: 'SkillWharf — заявка Design Partner',
  name: 'Имя / Компания',
  contact: 'Контакт',
  track: 'Отрасль',
  comment: 'Комментарий',
  emptyComment: '—',
};

const LEAD = {
  name: 'Иван, ООО «Пример»',
  contact: '@ivan_partner',
  track: 'wholesale',
  comment: 'Нужен пилот на 12 человек',
} as const;

function parseLead(overrides: Record<string, unknown> = {}): DesignPartnerLead {
  return designPartnerSchema.parse({ ...LEAD, ...overrides });
}

describe('designPartnerSchema', () => {
  it.each(['@ivan_partner', '+7 (999) 123-45-67', 'partner@example.ru'])(
    'принимает контакт %s',
    (contact) => {
      expect(parseLead({ contact }).contact).toBe(contact);
    },
  );

  it('обрезает пробелы в полях заявки', () => {
    const lead = parseLead({
      name: '  Иван  ',
      contact: '  @ivan_partner  ',
      comment: '  нужен пилот  ',
    });

    expect(lead).toMatchObject({
      name: 'Иван',
      contact: '@ivan_partner',
      comment: 'нужен пилот',
      track: 'wholesale',
    });
  });

  it('не передаёт пустой комментарий', () => {
    expect(parseLead({ comment: '   ' }).comment).toBeUndefined();
    expect(
      designPartnerSchema.parse({
        name: 'Иван',
        contact: 'partner@example.ru',
        track: 'pvz',
      }).comment,
    ).toBeUndefined();
  });

  it.each([
    ['слишком короткое имя', { name: 'A' }],
    ['неподдерживаемый контакт', { contact: 'hello' }],
    ['пустой контакт', { contact: '   ' }],
    ['неизвестный трек', { track: 'unknown' }],
    ['слишком длинный комментарий', { comment: 'x'.repeat(2_001) }],
  ])('отклоняет %s', (_label, overrides) => {
    expect(
      designPartnerSchema.safeParse({ ...LEAD, ...overrides }).success,
    ).toBe(false);
  });

  it('распознаёт допустимые формы контакта', () => {
    expect(isSupportedContact('partner@example.ru')).toBe(true);
    expect(isSupportedContact('+7 999 123-45-67')).toBe(true);
    expect(isSupportedContact('@ivan_partner')).toBe(true);
    expect(isSupportedContact('ivan')).toBe(false);
    expect(isSupportedContact('@iv')).toBe(false);
  });
});

describe('formatLeadMessage', () => {
  it('собирает заявку с подписями и выбранной отраслью', () => {
    const message = formatLeadMessage(parseLead(), 'K — Опт', LABELS);

    expect(message).toContain('SkillWharf — заявка Design Partner');
    expect(message).toContain('Имя / Компания: Иван, ООО «Пример»');
    expect(message).toContain('Контакт: @ivan_partner');
    expect(message).toContain('Отрасль: K — Опт');
    expect(message).toContain('Комментарий: Нужен пилот на 12 человек');
  });

  it('подставляет прочерк, если комментария нет', () => {
    const message = formatLeadMessage(
      parseLead({ comment: '  ' }),
      'A — ПВЗ',
      LABELS,
    );

    expect(message).toContain('Комментарий: —');
  });
});

describe('buildLeadMailto', () => {
  it('кодирует тему и тело письма', () => {
    const body = 'Строка 1\nСтрока 2 & ?';
    const href = buildLeadMailto('pilot@example.ru', 'Заявка: Иван', body);

    expect(href.startsWith('mailto:pilot@example.ru?subject=')).toBe(true);
    expect(href).toContain(encodeURIComponent('Заявка: Иван'));
    expect(href).toContain(encodeURIComponent(body));
  });
});

describe('buildLeadWebhookPayload', () => {
  it('добавляет источник, язык и время отправки', () => {
    const payload = buildLeadWebhookPayload(
      parseLead(),
      'ru',
      new Date('2026-11-18T10:00:00.000Z'),
    );

    expect(payload).toMatchObject({
      ...LEAD,
      source: 'landing',
      language: 'ru',
      submittedAt: '2026-11-18T10:00:00.000Z',
    });
  });
});

describe('submitLeadToWebhook', () => {
  const payload = buildLeadWebhookPayload(
    parseLead(),
    'en',
    new Date('2026-11-18T10:00:00.000Z'),
  );

  it('отправляет JSON POST на вебхук', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

    await submitLeadToWebhook(
      'https://hooks.example/lead',
      payload,
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example/lead',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
  });

  it('считает не-2xx ответ ошибкой, чтобы включить fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

    await expect(
      submitLeadToWebhook(
        'https://hooks.example/lead',
        payload,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow('500');
  });
});
