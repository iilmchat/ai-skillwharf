import type { ArgumentsHost, HttpException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsModule } from './documents.module.js';
import {
  DocumentsService,
  type ParsedDocumentResponse,
  type UploadedDocumentFile,
} from './documents.service.js';
import { UploadErrorFilter } from './upload-error.filter.js';

const RESPONSE: ParsedDocumentResponse = {
  id: 'doc-1',
  filename: 'contract.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  kind: 'pdf',
  text: 'Текст договора',
  tables: [],
  warnings: [],
  createdAt: '2026-11-14T10:00:00.000Z',
};

/** Запрос с аутентифицированным пользователем. */
function request(userId?: string): Request & {
  user?: { userId: string; email: string; role: string };
} {
  return {
    user:
      userId === undefined
        ? undefined
        : { userId, email: 'user@example.com', role: 'user' },
  } as Request & { user?: { userId: string; email: string; role: string } };
}

const FILE: UploadedDocumentFile = {
  originalname: 'contract.pdf',
  mimetype: 'application/pdf',
  size: 4,
  buffer: Buffer.from('%PDF'),
};

describe('DocumentsController', () => {
  const parse = vi.fn(async () => RESPONSE);
  const controller = new DocumentsController({
    parse,
  } as unknown as DocumentsService);

  it('передаёт файл в сервис и возвращает разобранный документ', async () => {
    const result = await controller.upload(request('user-1'), FILE);

    expect(parse).toHaveBeenCalledWith(FILE);
    expect(result).toEqual(RESPONSE);
  });

  it('без пользователя отдаёт 401', async () => {
    await expect(controller.upload(request(), FILE)).rejects.toMatchObject({
      status: 401,
    });
    expect(parse).not.toHaveBeenCalled();
  });

  it('без файла отдаёт 400 invalid_request', async () => {
    const error: unknown = await controller
      .upload(request('user-1'), undefined)
      .catch((caught: unknown) => caught);

    expect((error as HttpException).getResponse()).toMatchObject({
      statusCode: 400,
      code: 'errors.invalid_request',
    });
  });
});

/** Хост ответа для фильтра. */
function host(): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));

  return {
    host: {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost,
    status,
    json,
  };
}

describe('DocumentsModule', () => {
  it('собирается в Nest-контейнере (DI-зависимости разрешаются)', async () => {
    const previousSecret = process.env.JWT_SECRET;

    process.env.JWT_SECRET = 'test-secret';

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [PrismaModule, DocumentsModule],
      }).compile();

      expect(moduleRef.get(DocumentsService)).toBeInstanceOf(DocumentsService);
      expect(moduleRef.get(DocumentsController)).toBeInstanceOf(
        DocumentsController,
      );

      await moduleRef.close();
    } finally {
      if (previousSecret === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = previousSecret;
      }
    }
  });
});

describe('UploadErrorFilter', () => {
  const filter = new UploadErrorFilter();

  it('превращает LIMIT_FILE_SIZE в 413 document_too_large', () => {
    const { host: http, status, json } = host();
    const multerError = Object.assign(new Error('File too large'), {
      code: 'LIMIT_FILE_SIZE',
    });

    filter.catch(multerError, http);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'errors.document_too_large',
        statusCode: 413,
      }),
    );
  });

  it('пропускает HttpException в едином формате', () => {
    const { host: http, status, json } = host();

    filter.catch(new BadRequestException('нет файла'), http);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('неизвестную ошибку отдаёт как 500', () => {
    const { host: http, status, json } = host();

    filter.catch(new Error('boom'), http);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, error: 'Internal Server Error' }),
    );
  });
});
