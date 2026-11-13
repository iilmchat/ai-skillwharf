import { describe, expect, it } from 'vitest';
import { jsonSchemaToZod } from './tool-schema.js';

describe('jsonSchemaToZod', () => {
  it('строит объект с обязательными и необязательными полями', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    });

    expect(schema.parse({ query: 'ozon', limit: 5 })).toEqual({
      query: 'ozon',
      limit: 5,
    });
    expect(schema.parse({ query: 'ozon' })).toEqual({ query: 'ozon' });
    expect(() => schema.parse({ limit: 5 })).toThrow();
  });

  it('поддерживает массивы, enum и additionalProperties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' } },
        action: { enum: ['ozon_get_prices', 'ozon_orders_fbs'] },
        params: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['steps', 'action'],
    });

    const parsed = schema.parse({
      steps: ['a', 'b'],
      action: 'ozon_get_prices',
      params: { shop_id: '1' },
    });

    expect(parsed).toMatchObject({
      steps: ['a', 'b'],
      action: 'ozon_get_prices',
    });
  });

  it('неизвестная схема не роняет конвертацию', () => {
    expect(jsonSchemaToZod({ type: ['string', 'null'] }).safeParse('x').success)
      .toBe(true);
  });
});
