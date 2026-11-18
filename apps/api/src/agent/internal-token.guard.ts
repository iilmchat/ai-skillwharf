import {
  Injectable,
  Logger,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { InternalTokenAuth } from '@skillwharf/shared';
import type { Request } from 'express';
import { ApiException } from '../common/api-error.js';

/**
 * Защита внутренних эндпоинтов API (worker → API).
 *
 * Принимает короткоживущий JWT с `aud=internal-api` и `iss=skillwharf-worker`
 * (вызовы worker → API).
 * Статический `INTERNAL_API_TOKEN` — только при явном
 * `ALLOW_LEGACY_INTERNAL_TOKEN=true` вне production (dev/тесты).
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly logger = new Logger(InternalTokenGuard.name);

  constructor(@Optional() private readonly auth?: InternalTokenAuth) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = this.auth ?? new InternalTokenAuth();

    try {
      auth.verify(request.header('x-internal-token'), 'internal-api');
      return true;
    } catch (error) {
      this.logger.warn(
        `внутренний токен отклонён: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new ApiException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'errors.internal_unauthorized',
        message: 'Invalid internal token',
      });
    }
  }
}
