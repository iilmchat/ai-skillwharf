import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  documentTooLargeError,
  type ApiException,
} from '../common/api-error.js';
import { MAX_UPLOAD_BYTES } from './documents.service.js';

/**
 * Ошибки загрузки документа в едином JSON-формате.
 *
 * Multer прерывает запрос собственным `MulterError` (не `HttpException`),
 * поэтому без фильтра клиент получил бы 500 без кода. `LIMIT_FILE_SIZE`
 * превращается в 413 `errors.document_too_large`; остальные ошибки отдаются
 * штатным форматом Nest, а неизвестные — 500.
 */
@Catch()
export class UploadErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (isFileSizeError(exception)) {
      const error: ApiException = documentTooLargeError(
        `Файл больше ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ`,
      );

      response.status(error.getStatus()).json(error.getResponse());

      return;
    }

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());

      return;
    }

    response.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'errors.internal',
      message: 'Не удалось разобрать документ',
    });
  }
}

/** Multer сообщает о превышении лимита кодом `LIMIT_FILE_SIZE`. */
function isFileSizeError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) {
    return false;
  }

  const code = (exception as { code?: unknown }).code;

  return code === 'LIMIT_FILE_SIZE';
}
