import {
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import { MemoryQuerySchema } from './dto/memory-query.dto.js';
import {
  MemoryListResponseSchema,
  type MemoryListResponse,
} from './dto/memory-response.dto.js';
import { MemoryService } from './memory.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/**
 * Read-API долговременной памяти пользователя.
 *
 * Отдаёт только собственные фрагменты: `userId` берётся из JWT-контекста
 * (`request.user.userId`), а не из query-параметров. Query и ответ проходят
 * Zod-валидацию, чтобы контракт `GET /api/v1/chat/memory` не «плыл».
 */
@Controller('chat')
export class MemoryController {
  private readonly logger = new Logger(MemoryController.name);

  constructor(private readonly memoryService: MemoryService) {}

  /**
   * Страница фрагментов RAG-памяти текущего пользователя.
   * `GET /api/v1/chat/memory?limit=20&offset=0`.
   */
  @Get('memory')
  @UseGuards(JwtAuthGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<MemoryListResponse> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    const parsedQuery = MemoryQuerySchema.safeParse(query);

    if (!parsedQuery.success) {
      throw invalidRequestError(
        `Некорректные параметры запроса: ${parsedQuery.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
    }

    const page = await this.memoryService.list(userId, parsedQuery.data);
    const parsedResponse = MemoryListResponseSchema.safeParse(page);

    if (!parsedResponse.success) {
      // Ответ сервиса разошёлся с контрактом: это баг API, а не клиента.
      // Клиенту отдаём 500 без вымышленных данных.
      this.logger.error(
        `Ответ read-API памяти не соответствует контракту: ${parsedResponse.error.message}`,
      );
      throw new InternalServerErrorException(
        'Ответ read-API памяти не соответствует контракту',
      );
    }

    return parsedResponse.data;
  }
}
