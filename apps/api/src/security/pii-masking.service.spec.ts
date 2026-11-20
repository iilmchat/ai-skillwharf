import { describe, expect, it } from 'vitest';
import {
  maskPii,
  passesLuhn,
  PiiMaskingService,
  unmaskPii,
} from './pii-masking.service.js';

describe('PII-маскирование (PII-44.1/44.2)', () => {
  const service = new PiiMaskingService({ PII_MASKING_ENABLED: 'true' });

  it('маскирует и восстанавливает все 6 типов ПДн', () => {
    const source = [
      'Клиент +7 (999) 123-45-67 написал на ivan.petrov@example.com.',
      'СНИЛС 123-456-789 01, ИНН 7700000000.',
      'Паспорт 45 01 123456, карта 4111111111111111.',
    ].join('\n');

    const result = service.maskPii(source);

    expect(result.maskedCount).toBe(6);
    expect(result.maskedText).toContain('[PHONE_1]');
    expect(result.maskedText).toContain('[EMAIL_1]');
    expect(result.maskedText).toContain('[SNILS_1]');
    expect(result.maskedText).toContain('[INN_1]');
    expect(result.maskedText).toContain('[PASSPORT_1]');
    expect(result.maskedText).toContain('[CARD_1]');
    expect(result.maskedText).not.toContain('4111111111111111');
    expect(result.maskedText).not.toContain('ivan.petrov@example.com');

    expect(service.unmaskPii(result.maskedText, result.tokensMap)).toBe(source);
  });

  it('текст без ПДн остаётся без изменений', () => {
    const text = 'Сделай сводку остатков по складу за вчерашний день.';
    const result = service.maskPii(text);

    expect(result.maskedCount).toBe(0);
    expect(result.maskedText).toBe(text);
    expect(result.tokensMap.size).toBe(0);
    expect(unmaskPii(result.maskedText, result.tokensMap)).toBe(text);
  });

  it('карта с неверной контрольной суммой не маскируется', () => {
    const text = 'Номер карты 4111111111111112 не проходит проверку.';

    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(service.maskPii(text).maskedCount).toBe(0);
  });

  it('общий state даёт сквозную нумерацию токенов', () => {
    const state = {
      map: new Map<string, string>(),
      counters: new Map<string, number>(),
    };
    const first = maskPii('Телефон +7 999 123-45-67', state);
    const second = maskPii('Ещё +7 999 765-43-21', state);

    expect(first.maskedText).toContain('[PHONE_1]');
    expect(second.maskedText).toContain('[PHONE_2]');
    expect(second.tokensMap.size).toBe(2);
    expect(
      unmaskPii(`${first.maskedText}; ${second.maskedText}`, state.map),
    ).toBe('Телефон +7 999 123-45-67; Ещё +7 999 765-43-21');
  });

  it('флаг по умолчанию выключен и валидируется Zod', () => {
    expect(new PiiMaskingService().enabled).toBe(false);
    expect(new PiiMaskingService({ PII_MASKING_ENABLED: 'maybe' }).enabled).toBe(
      false,
    );
    expect(service.enabled).toBe(true);
  });
});
