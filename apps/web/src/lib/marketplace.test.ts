import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMarketplaceSkills,
  installMarketplaceSkill,
  MarketplaceError,
  MARKETPLACE_TRACK_IDS,
  marketplaceListResponseSchema,
  marketplaceSkillSchema,
} from './marketplace';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock },
}));

const VALID_SKILL = {
  id: 'skill-1',
  slug: 'ocr-invoice-parser',
  name: 'OCR разбора счетов',
  version: '1.2.0',
  description: 'Разбирает счета и накладные.',
  trackIds: ['I', 'H'],
  authorName: 'ООО «Пример»',
  verified: true,
  pricingModel: 'Pay-per-Call',
  price: '15.00',
  downloadsCount: 42,
  installed: false,
  permissions: ['files:read', 'ocr:parse'],
  signature: { verified: true, publicKeyId: 'key-2026' },
};

const VALID_LIST = { items: [VALID_SKILL], total: 1 };

function httpError(status: number): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: {},
    data: { message: 'ошибка сервера' },
  } as unknown as AxiosResponse;

  return new AxiosError('запрос отклонён', undefined, undefined, undefined, response);
}

describe('маркетплейс: Zod-контракт', () => {
  it('принимает ответ списка и приводит цену-строку к числу', () => {
    const parsed = marketplaceListResponseSchema.safeParse(VALID_LIST);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data.total).toBe(1);
    expect(parsed.data.items[0]?.price).toBe(15);
    expect(parsed.data.items[0]?.slug).toBe('ocr-invoice-parser');
  });

  it('сохраняет статус Ed25519 и необязательные детали навыка', () => {
    const parsed = marketplaceSkillSchema.parse(VALID_SKILL);

    expect(parsed.verified).toBe(true);
    expect(parsed.signature).toEqual({
      verified: true,
      publicKeyId: 'key-2026',
    });
    expect(parsed.permissions).toEqual(['files:read', 'ocr:parse']);
    expect(marketplaceSkillSchema.parse({ ...VALID_SKILL, verified: false }).verified).toBe(false);
  });

  it('отвергает неверный трек, модель оплаты и строку вместо verified', () => {
    expect(
      marketplaceSkillSchema.safeParse({
        ...VALID_SKILL,
        trackIds: ['M'],
      }).success,
    ).toBe(false);
    expect(
      marketplaceSkillSchema.safeParse({
        ...VALID_SKILL,
        pricingModel: 'Pay-per-Month',
      }).success,
    ).toBe(false);
    expect(
      marketplaceSkillSchema.safeParse({ ...VALID_SKILL, verified: 'true' })
        .success,
    ).toBe(false);
    expect(MARKETPLACE_TRACK_IDS).toHaveLength(12);
  });
});

describe('fetchMarketplaceSkills', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('отправляет только заполненные query-параметры', async () => {
    getMock.mockResolvedValue({ data: VALID_LIST });

    await fetchMarketplaceSkills();
    expect(getMock).toHaveBeenCalledWith('/marketplace/skills', { params: {} });

    await fetchMarketplaceSkills({
      search: '  invoice  ',
      track: 'I',
      pricingModel: 'Pay-per-Call',
      verified: false,
    });
    expect(getMock).toHaveBeenLastCalledWith('/marketplace/skills', {
      params: {
        search: 'invoice',
        track: 'I',
        pricingModel: 'Pay-per-Call',
        verified: 'false',
      },
    });
  });

  it('возвращает провалидированный список', async () => {
    getMock.mockResolvedValue({ data: VALID_LIST });

    const result = await fetchMarketplaceSkills({ track: 'I' });

    expect(result.items[0]?.price).toBe(15);
    expect(result.total).toBe(1);
  });

  it('превращает 404/501 в ошибку недоступности раздела', async () => {
    getMock.mockRejectedValueOnce(httpError(404));
    getMock.mockRejectedValueOnce(httpError(501));

    await expect(fetchMarketplaceSkills()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(fetchMarketplaceSkills()).rejects.toBeInstanceOf(
      MarketplaceError,
    );
  });

  it('превращает невалидный ответ в ошибку валидации', async () => {
    getMock.mockResolvedValue({ data: { items: [{ id: 'x' }], total: 1 } });

    await expect(fetchMarketplaceSkills()).rejects.toMatchObject({
      code: 'invalidResponse',
    });
  });
});

describe('installMarketplaceSkill', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it('устанавливает навык по slug и читает ответ через Zod', async () => {
    postMock.mockResolvedValue({
      data: {
        installedId: 'installed-1',
        name: 'OCR разбора счетов',
        slug: 'ocr-invoice-parser',
        downloadsCount: 43,
      },
    });

    const result = await installMarketplaceSkill('ocr-invoice-parser');

    expect(postMock).toHaveBeenCalledWith(
      '/marketplace/skills/ocr-invoice-parser/install',
    );
    expect(result).toEqual({
      installedId: 'installed-1',
      name: 'OCR разбора счетов',
      slug: 'ocr-invoice-parser',
      downloadsCount: 43,
    });
  });

  it('отвергает некорректный slug до запроса', async () => {
    await expect(installMarketplaceSkill('../etc/passwd')).rejects.toThrow();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('различает ошибки установки по коду', async () => {
    postMock.mockRejectedValueOnce(httpError(404));
    postMock.mockRejectedValueOnce(httpError(501));
    postMock.mockRejectedValueOnce(httpError(401));
    postMock.mockRejectedValueOnce(httpError(500));
    postMock.mockRejectedValueOnce(new AxiosError('нет сети'));

    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'sessionExpired',
    });
    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'installFailed',
    });
    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('невалидный ответ установки не попадает в UI', async () => {
    postMock.mockResolvedValue({ data: { installedId: 7 } });

    await expect(installMarketplaceSkill('my-skill')).rejects.toMatchObject({
      code: 'invalidResponse',
    });
  });
});
