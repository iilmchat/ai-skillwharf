import {
  Injectable,
  Logger,
  Optional,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalTokenAuth } from '@skillwharf/shared';
import type { Request } from 'express';

/**
 * Защита `/v1/graphs/*`: ожидает JWT от API с `iss=skillwharf-api`,
 * `aud=internal-worker`. Статический токен — только для dev-совместимости
 * с явным `ALLOW_LEGACY_INTERNAL_TOKEN=true`.
 */
@Injectable()
export class InternalJwtGuard implements CanActivate {
  private readonly logger = new Logger(InternalJwtGuard.name);

  constructor(@Optional() private readonly auth?: InternalTokenAuth) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = this.auth ?? new InternalTokenAuth();

    try {
      auth.verify(request.header('x-internal-token'), 'internal-worker');
      return true;
    } catch (error) {
      this.logger.warn(
        `internal token rejected: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new UnauthorizedException('Invalid internal token');
    }
  }
}
