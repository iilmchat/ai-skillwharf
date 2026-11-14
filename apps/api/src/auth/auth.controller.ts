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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  AuthService,
  type AuthTokens,
  type UserProfile,
} from './auth.service.js';
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

export type { UserProfile } from './auth.service.js';

/** Лимиты можно ослабить в E2E через env, в production по умолчанию строгие. */
function limitFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const LOGIN_LIMIT = limitFromEnv('AUTH_LOGIN_LIMIT', 5);
const REGISTER_LIMIT = limitFromEnv('AUTH_REGISTER_LIMIT', 10);

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: REGISTER_LIMIT, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Регистрация пользователя' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Пользователь создан, возвращены id и email.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Тело запроса не прошло валидацию.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Пользователь с таким email уже существует.',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'Превышен лимит регистраций.',
  })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ default: { limit: LOGIN_LIMIT, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Вход по email и паролю' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Пара access/refresh токенов.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Неверный email или пароль.',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'Превышен лимит попыток входа.',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обновление пары токенов' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Новые access и refresh токены.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Refresh-токен недействителен или истёк.',
  })
  async refresh(@Body() dto: RefreshDto): Promise<AuthTokens> {
    const payload = await this.authService.verifyRefreshToken(dto.refreshToken);

    return this.authService.refreshTokens(payload.sub, dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Профиль текущего пользователя' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Профиль и дневной лимит токенов.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  async me(@Req() request: AuthenticatedRequest): Promise<UserProfile> {
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.authService.getProfile(user.userId);
  }
}
