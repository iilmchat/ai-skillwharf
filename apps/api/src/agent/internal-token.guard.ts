import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Проверка общего внутреннего токена. Если `INTERNAL_API_TOKEN` не задан,
 * запросы разрешены только для локальной разработки (в compose токен задан).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly logger = new Logger(InternalTokenGuard.name);
  private warned = false;

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_TOKEN?.trim() ?? '';

    if (expected === '') {
      if (!this.warned) {
        this.logger.warn(
          'INTERNAL_API_TOKEN не задан: внутренние эндпоинты открыты (только для dev)',
        );
        this.warned = true;
      }

      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header('x-internal-token');

    if (token !== expected) {
      throw new UnauthorizedException('Invalid internal token');
    }

    return true;
  }
}
