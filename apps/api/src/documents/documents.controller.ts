import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import {
  DocumentsService,
  MAX_UPLOAD_BYTES,
  type ParsedDocumentResponse,
  type UploadedDocumentFile,
} from './documents.service.js';
import { UploadErrorFilter } from './upload-error.filter.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Лимит загрузок документов на пользователя в минуту. */
export const DOCUMENTS_UPLOAD_RATE_LIMIT = 30;

/**
 * Загрузка документов из UI (`apps/web/src/lib/documents.ts`).
 *
 * `multipart/form-data`, поле `file`, лимит 15 МБ, только PDF и изображения.
 * Парсинг выполняет `DocumentsService`; авторизация — JWT, как у остальных
 * пользовательских маршрутов.
 */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** `POST /api/v1/documents` — разбор загруженного файла. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseFilters(UploadErrorFilter)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: UploadedDocumentFile,
  ): Promise<ParsedDocumentResponse> {
    if (request.user?.userId === undefined) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    if (file === undefined) {
      throw invalidRequestError('Файл не передан: ожидается поле file');
    }

    return this.documents.parse(file);
  }
}
