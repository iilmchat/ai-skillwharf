import { describe, expect, it } from 'vitest';
import {
  extractAmounts,
  extractContractNumber,
  extractDates,
  extractDocumentFields,
  extractParties,
  parseAmount,
} from './document-fields.js';

const CONTRACT = `ДОГОВОР № 42/2026
г. Москва                                          12 марта 2026 г.

ООО «Ромашка», именуемое в дальнейшем «Заказчик», в лице генерального
директора Иванова Ивана Ивановича, действующего на основании Устава, и
АО «Вектор», именуемое в дальнейшем «Исполнитель», заключили настоящий
договор о нижеследующем.

1. Предмет договора
Исполнитель обязуется оказать услуги по разработке программного обеспечения.

2. Цена договора
Общая стоимость услуг составляет 1 500 000,00 руб., в том числе НДС 20% —
250 000 руб. Аванс 300 000 ₽ перечисляется до 01.04.2026.

Реквизиты:
ООО «Ромашка», ИНН 7701234567, КПП 770101001, ОГРН 1027700132195
`;

describe('extractDocumentFields: реальные реквизиты договора', () => {
  it('извлекает номер, стороны, суммы, даты и реквизиты', () => {
    const fields = extractDocumentFields(CONTRACT);

    expect(fields.contractNumber).toBe('42/2026');
    expect(fields.subject).toBe(
      'Исполнитель обязуется оказать услуги по разработке программного обеспечения.',
    );
    expect(fields.parties).toEqual([
      { kind: 'ООО', name: 'Ромашка', raw: 'ООО «Ромашка»' },
      { kind: 'АО', name: 'Вектор', raw: 'АО «Вектор»' },
    ]);
    expect(fields.primaryAmount).toMatchObject({
      value: 1_500_000,
      currency: 'RUB',
    });
    expect(fields.amounts.map((amount) => amount.value)).toEqual([
      1_500_000, 250_000, 300_000,
    ]);
    // Договор датирован 12 марта, аванс — 01.04.2026; основная дата первая.
    expect(fields.primaryDate?.iso).toBe('2026-03-12');
    expect(fields.dates.map((date) => date.iso)).toEqual([
      '2026-03-12',
      '2026-04-01',
    ]);
    expect(fields.inn).toEqual(['7701234567']);
    expect(fields.kpp).toEqual(['770101001']);
    expect(fields.ogrn).toEqual(['1027700132195']);
    expect(fields.signatory).toBe(
      'генерального директора Иванова Ивана Ивановича',
    );
    expect(fields.warnings).toEqual([]);
  });

  it('не придумывает значения в тексте без реквизитов', () => {
    const fields = extractDocumentFields(
      'Привет! Это заметка без договора, сумм и дат.',
    );

    expect(fields.amounts).toEqual([]);
    expect(fields.dates).toEqual([]);
    expect(fields.parties).toEqual([]);
    expect(fields.primaryAmount).toBeNull();
    expect(fields.primaryDate).toBeNull();
    expect(fields.contractNumber).toBeNull();
    expect(fields.signatory).toBeNull();
    expect(fields.warnings).toEqual(
      expect.arrayContaining([
        'в тексте не найдено сумм с валютой',
        'в тексте не найдено дат',
        'номер договора не найден',
      ]),
    );
  });

  it('сообщает о пустом документе', () => {
    expect(extractDocumentFields('   \n\t ')).toMatchObject({
      amounts: [],
      dates: [],
      warnings: ['документ пуст'],
    });
  });

  it('не принимает несуществующие даты', () => {
    expect(extractDates('Дата: 32.13.2026')).toEqual([]);
    expect(extractDates('Дата: 31.02.2026')).toEqual([]);
    expect(extractDates('Дата: 29.02.2024').map((date) => date.iso)).toEqual([
      '2024-02-29',
    ]);
  });

  it('понимает даты в ISO и длинном формате', () => {
    expect(
      extractDates('подписано 2026-11-13, оплата до «5» мая 2027 г.').map(
        (date) => date.iso,
      ),
    ).toEqual(['2026-11-13', '2027-05-05']);
  });
});

describe('extractAmounts', () => {
  it('разбирает пробелы, запятые и валюты', () => {
    const amounts = extractAmounts(
      'Итого: 1 500 000,00 руб.; предоплата 300 000 ₽; штраф $1,234.56; курс 100 EUR',
    );

    expect(amounts.map((amount) => [amount.value, amount.currency])).toEqual([
      [1_500_000, 'RUB'],
      [300_000, 'RUB'],
      [1_234.56, 'USD'],
      [100, 'EUR'],
    ]);
  });

  it('сохраняет окружение найденной суммы для проверки человеком', () => {
    const [amount] = extractAmounts('Цена договора — 900 000 руб. без НДС.');

    expect(amount?.context).toBe('Цена договора — 900 000 руб. без НДС.');
  });
});

describe('parseAmount', () => {
  it.each([
    ['1 500 000,00', 1_500_000],
    ['1.500.000,50', 1_500_000.5],
    ['150000.00', 150_000],
    ['1,234.56', 1_234.56],
    ['42', 42],
  ])('превращает %s в %s', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it('не разбирает нечисловые значения', () => {
    expect(parseAmount('—')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('номер договора и стороны', () => {
  it('находит разные варианты номера', () => {
    expect(extractContractNumber('Договор № 7-А/2026 оказания услуг')).toBe(
      '7-А/2026',
    );
    expect(extractContractNumber('Контракт номер 15 от 01.01.2026')).toBe(
      '15',
    );
    expect(extractContractNumber('без номера')).toBeNull();
  });

  it('не путает предлог ИП со стороной', () => {
    const parties = extractParties(
      'ИП Петров Пётр, ИНН 500100200300, и ООО «Ромашка»',
    );

    expect(parties.map((party) => `${party.kind} ${party.name}`)).toEqual([
      'ИП Петров Пётр',
      'ООО Ромашка',
    ]);
  });
});
