import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { invalidRequestError } from '../../common/api-error.js';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { GoogleConfig } from './google.config.js';
import {
  GoogleOAuthService,
  type GoogleConnectionStatus,
} from './google-oauth.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});

/**
 * OAuth-flow Google Workspace.
 *
 * `GET /authorize` — начать подключение (JWT); `GET /callback` — приём кода
 * от Google (без JWT: пользователя определяет подписанный state);
 * `GET /status` и `DELETE /` управляют подключением.
 */
@Controller('integrations/google')
export class GoogleController {
  private readonly logger = new Logger(GoogleController.name);
  private readonly config: GoogleConfig;

  constructor(
    private readonly oauth: GoogleOAuthService,
    @Optional() config?: GoogleConfig,
  ) {
    this.config = config ?? GoogleConfig.fromEnv();
  }

  /** URL согласия Google; state подписан и привязан к пользователю. */
  @Get('authorize')
  @UseGuards(JwtAuthGuard)
  async authorize(@Req() request: AuthenticatedRequest): Promise<{
    url: string;
    state: string;
  }> {
    const userId = requireUserId(request);

    return this.oauth.buildAuthUrl(userId);
  }

  /** Алиас для UI (`GET /integrations/google/authorization-url`). */
  @Get('authorization-url')
  @UseGuards(JwtAuthGuard)
  async authorizationUrl(@Req() request: AuthenticatedRequest): Promise<{
    url: string;
    authorizationUrl: string;
  }> {
    const userId = requireUserId(request);
    const { url } = this.oauth.buildAuthUrl(userId);

    return { url, authorizationUrl: url };
  }

  /** Callback Google: обмен кода на токены и сохранение подключения. */
  @Get('callback')
  async callback(
    @Query() query: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = callbackQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw invalidRequestError('Google OAuth: некорректные query-параметры');
    }

    if (parsed.data.error !== undefined) {
      if (this.config.successRedirect !== null) {
        response.redirect(
          302,
          redirectUrl(this.config.successRedirect, 'error'),
        );

        return;
      }

      throw invalidRequestError(
        `Google OAuth отклонён: ${parsed.data.error}${
          parsed.data.error_description === undefined
            ? ''
            : ` (${parsed.data.error_description})`
        }`,
      );
    }

    if (parsed.data.code === undefined || parsed.data.state === undefined) {
      throw invalidRequestError('Google OAuth: ожидаются code и state');
    }

    const result = await this.oauth.handleCallback(
      parsed.data.code,
      parsed.data.state,
    );

    this.logger.log(
      JSON.stringify({ event: 'google.oauth.callback', scope: result.scope }),
    );

    if (this.config.successRedirect !== null) {
      response.redirect(
        302,
        redirectUrl(this.config.successRedirect, 'success'),
      );

      return;
    }

    response.json({
      connected: true,
      scope: result.scope,
      expiresAt: result.expiresAt.toISOString(),
    });
  }

  /** Статус подключения Google для текущего пользователя. */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async status(
    @Req() request: AuthenticatedRequest,
  ): Promise<GoogleConnectionStatus> {
    const userId = requireUserId(request);

    return this.oauth.status(userId);
  }

  /** Отзыв локального подключения (токены удаляются). */
  @Delete()
  @UseGuards(JwtAuthGuard)
  async disconnect(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ disconnected: boolean }> {
    const userId = requireUserId(request);

    return { disconnected: await this.oauth.disconnect(userId) };
  }

  /**
   * Ручной обмен кода (для диагностики из Control Plane): тот же flow, что
   * callback, но без браузерного редиректа.
   */
  @Post('exchange')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async exchange(@Body() body: unknown): Promise<{
    connected: boolean;
    scope: string;
    expiresAt: string;
  }> {
    const parsed = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .strict()
      .safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { code, state }');
    }

    const result = await this.oauth.handleCallback(
      parsed.data.code,
      parsed.data.state,
    );

    return {
      connected: true,
      scope: result.scope,
      expiresAt: result.expiresAt.toISOString(),
    };
  }
}

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}

/**
 * URL возврата в UI: добавляет `integration=google&status=...` к базовому
 * адресу (абсолютному или относительному).
 */
export function redirectUrl(base: string, status: 'success' | 'error'): string {
  const separator = base.includes('?') ? '&' : '?';

  return `${base}${separator}integration=google&status=${status}`;
}
