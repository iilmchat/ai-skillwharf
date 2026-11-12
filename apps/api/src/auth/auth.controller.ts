import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AuthTokens } from './auth.service.js';
import { Roles } from './decorators/roles.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { RolesGuard } from './guards/roles.guard.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface UserProfile {
  id: string;
  email: string;
  role: string;
}

/** Лимиты можно ослабить в E2E через env, в production по умолчанию строгие. */
function limitFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const LOGIN_LIMIT = limitFromEnv('AUTH_LOGIN_LIMIT', 5);
const REGISTER_LIMIT = limitFromEnv('AUTH_REGISTER_LIMIT', 10);

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: REGISTER_LIMIT, ttl: 3_600_000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: LOGIN_LIMIT, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto): Promise<AuthTokens> {
    const payload = await this.authService.verifyRefreshToken(dto.refreshToken);

    return this.authService.refreshTokens(payload.sub, dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  me(@Req() request: AuthenticatedRequest): UserProfile {
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return { id: user.userId, email: user.email, role: user.role };
  }
}
