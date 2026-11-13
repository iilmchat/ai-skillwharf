import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { MemoryListResponseSchema } from './dto/memory-response.dto.js';
import { MemoryController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const CREATED_AT = '2026-11-13T10:00:00.000Z';

const PAGE = {
  items: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      content: 'Клиент предпочитает самовывоз',
      createdAt: CREATED_AT,
    },
  ],
  total: 3,
};

type MockFn = ReturnType<typeof vi.fn>;

interface MemoryServiceMock {
  list: MockFn;
}

type ControllerRequest = Parameters<MemoryController['list']>[0];

interface TestUser {
  userId: string;
  email: string;
  role: string;
}

const TEST_USER: TestUser = {
  userId: USER_ID,
  email: 'user@example.com',
  role: 'user',
};

function createRequest(user?: TestUser): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

describe('MemoryController', () => {
  let controller: MemoryController;
  let memory: MemoryServiceMock;

  beforeEach(async () => {
    memory = { list: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MemoryController],
      providers: [{ provide: MemoryService, useValue: memory }],
    }).compile();

    controller = moduleRef.get(MemoryController);
  });

  /** Вызывает list и возвращает Api-ошибку 400 (сервис не должен вызываться). */
  async function expectInvalidQuery(
    query: Record<string, string>,
  ): Promise<ApiException> {
    let caught: unknown;

    try {
      await controller.list(createRequest(TEST_USER), query);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiException);
    expect((caught as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: 'errors.invalid_request',
      message: expect.stringContaining('Некорректные параметры запроса'),
    });
    expect(memory.list).not.toHaveBeenCalled();

    return caught as ApiException;
  }

  it('требует аутентификации и не обращается к сервису', async () => {
    await expect(
      controller.list(createRequest(), { limit: '10' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(memory.list).not.toHaveBeenCalled();
  });

  it('вызывает сервис с userId из JWT и параметрами страницы', async () => {
    memory.list.mockResolvedValue(PAGE);

    await expect(
      controller.list(createRequest(TEST_USER), { limit: '5', offset: '10' }),
    ).resolves.toEqual(PAGE);

    // userId — только из JWT: клиентского значения в аргументах нет.
    expect(memory.list).toHaveBeenCalledWith(USER_ID, { limit: 5, offset: 10 });
  });

  it('подставляет limit=20 и offset=0 по умолчанию', async () => {
    memory.list.mockResolvedValue({ items: [], total: 0 });

    await controller.list(createRequest(TEST_USER), {});

    expect(memory.list).toHaveBeenCalledWith(USER_ID, {
      limit: 20,
      offset: 0,
    });
  });

  it('отдаёт total из сервиса — общее количество, а не длина страницы', async () => {
    memory.list.mockResolvedValue({ items: PAGE.items, total: 42 });

    await expect(
      controller.list(createRequest(TEST_USER), {}),
    ).resolves.toEqual({ items: PAGE.items, total: 42 });
  });

  it.each<[string, Record<string, string>]>([
    ['limit=0', { limit: '0' }],
    ['limit=101', { limit: '101' }],
    ['limit не число', { limit: 'abc' }],
    ['offset=-1', { offset: '-1' }],
    ['offset больше 10000', { offset: '10001' }],
    ['лишний параметр', { limit: '10', userId: USER_ID }],
  ])('отклоняет некорректный query: %s', async (_name, query) => {
    await expectInvalidQuery(query);
  });

  it('не принимает userId из query даже вместе с валидными параметрами', async () => {
    const error = await expectInvalidQuery({
      limit: '1',
      offset: '0',
      userId: '33333333-3333-3333-3333-333333333333',
    });

    expect(error.getResponse().message).toContain('userId');
  });

  it('отдаёт 500, если ответ сервиса разошёлся с контрактом', async () => {
    memory.list.mockResolvedValue({
      items: [{ id: 'chunk-1', content: 'текст', createdAt: 'вчера' }],
      total: 1,
    });

    await expect(
      controller.list(createRequest(TEST_USER), {}),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('MemoryListResponseSchema', () => {
  it('принимает контрактный ответ с ISO-датой и total', () => {
    expect(MemoryListResponseSchema.parse(PAGE)).toEqual(PAGE);
  });

  it.each<[string, unknown]>([
    ['items не массив', { items: null, total: 0 }],
    [
      'пустой id',
      {
        items: [{ id: '', content: 'текст', createdAt: CREATED_AT }],
        total: 1,
      },
    ],
    [
      'пустой content',
      { items: [{ id: 'id-1', content: '', createdAt: CREATED_AT }], total: 1 },
    ],
    [
      'не ISO дата',
      {
        items: [{ id: 'id-1', content: 'текст', createdAt: 'вчера' }],
        total: 1,
      },
    ],
    ['дробный total', { items: [], total: 1.5 }],
    ['отрицательный total', { items: [], total: -1 }],
  ])('отклоняет ответ с расхождением контракта: %s', (_name, payload) => {
    expect(MemoryListResponseSchema.safeParse(payload).success).toBe(false);
  });
});
