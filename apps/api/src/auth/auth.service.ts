import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  invalidInviteCodeError,
  invalidRequestError,
  registrationClosedError,
} from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto, registerSchema } from './dto/register.dto.js';
import type { JwtPayload } from './jwt.strategy.js';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '7d';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisteredUser {
  id: string;
  email: string;
}

/** Профиль пользователя: JWT-данные плюс эффективный дневной расход токенов. */
export interface UserProfile {
  id: string;
  email: string;
  role: string;
  dailyTokenLimit: number;
  dailyTokensUsed: number;
}

/** Режим регистрации (`REGISTRATION_MODE`, KI-073). */
export const registrationModeSchema = z.enum(['open', 'invite', 'closed']);

export type RegistrationMode = z.infer<typeof registrationModeSchema>;

/** Непустое значение окружения или `null`. */
function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[name]?.trim() ?? '';

  return value === '' ? null : value;
}

/**
 * Строгая проверка `REGISTRATION_MODE` при старте.
 *
 * `null` — переменная не задана (режим вычисляется по invite-коду). Если
 * значение задано и не входит в enum, Zod бросает ошибку: приложение должно
 * упасть на старте, а не открыть регистрацию из-за опечатки в `.env`.
 */
export function parseRegistrationModeEnv(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationMode | null {
  const raw = env.REGISTRATION_MODE?.trim();

  if (raw === undefined || raw === '') {
    return null;
  }

  return registrationModeSchema.parse(raw.toLowerCase());
}

/**
 * Режим регистрации из окружения.
 *
 * Явный `REGISTRATION_MODE` имеет приоритет. Без него: если задан
 * `REGISTRATION_INVITE_CODE` — режим `invite`, иначе `open` (dev/тесты).
 * Некорректное значение, попавшее в процесс уже после старта, трактуется
 * как `closed` (fail closed).
 */
export function resolveRegistrationMode(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationMode {
  const raw = env.REGISTRATION_MODE?.trim();

  if (raw !== undefined && raw !== '') {
    const parsed = registrationModeSchema.safeParse(raw.toLowerCase());

    return parsed.success ? parsed.data : 'closed';
  }

  return readEnv('REGISTRATION_INVITE_CODE', env) === null ? 'open' : 'invite';
}

/** Сравнение инвайт-кодов без раннего выхода (constant-time). */
function inviteCodeMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Начало текущих суток в UTC. Дублирует границу из Budget Guard в LlmService,
 * чтобы auth не зависел от llm-модуля.
 */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {
    // Fail fast: опечатка в REGISTRATION_MODE не должна открыть регистрацию.
    parseRegistrationModeEnv();
  }

  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const parsed = registerSchema.safeParse(dto);

    if (!parsed.success) {
      throw invalidRequestError('Некорректные данные регистрации');
    }

    // Режим проверяем до обращения к БД: закрытая регистрация не должна
    // раскрывать, занят ли email.
    this.assertRegistrationAllowed(parsed.data.inviteCode);

    const existing = await this.prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const passwordHash = await argon2.hash(parsed.data.password);

    return this.prisma.user.create({
      data: { email: parsed.data.email, passwordHash },
      select: { id: true, email: true },
    });
  }

  /** KI-073: `closed` — всегда 403; `invite` — только с верным кодом. */
  private assertRegistrationAllowed(inviteCode: string | undefined): void {
    const mode = resolveRegistrationMode();

    if (mode === 'closed') {
      throw registrationClosedError('Регистрация новых пользователей закрыта');
    }

    if (mode !== 'invite') {
      return;
    }

    const expected = readEnv('REGISTRATION_INVITE_CODE');

    if (
      expected === null ||
      inviteCode === undefined ||
      !inviteCodeMatches(inviteCode, expected)
    ) {
      throw invalidInviteCodeError('Неверный или отсутствующий инвайт-код');
    }
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const tokens = await this.signTokens(payload);

    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: await argon2.hash(tokens.refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return tokens;
  }

  /**
   * Профиль для GET /auth/me. Счётчик токенов сбрасывается лениво при первом
   * LLM-запросе нового дня, поэтому в read-path «протухший» счётчик отдаём
   * нулём, не мутируя БД.
   */
  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        dailyTokenLimit: true,
        dailyTokensUsed: true,
        lastTokenReset: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Пользователь не найден');
    }

    const resetRequired =
      user.lastTokenReset.getTime() < startOfUtcDay(new Date()).getTime();

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      dailyTokenLimit: user.dailyTokenLimit,
      dailyTokensUsed: resetRequired ? 0 : user.dailyTokensUsed,
    };
  }

  /**
   * Проверяет подпись refresh-токена и возвращает его payload.
   * Используется контроллером, чтобы получить userId до обращения к БД.
   */
  async verifyRefreshToken(token: string): Promise<JwtPayload> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Недействительный refresh-токен');
    }
  }

  /**
   * Ротация refresh-токена: находит активную сессию пользователя, у которой
   * хеш совпадает с присланным токеном, и заменяет пару токенов.
   */
  async refreshTokens(userId: string, refreshToken: string): Promise<AuthTokens> {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
      include: { user: { select: { email: true, role: true } } },
    });

    let matchedSession:
      | (typeof sessions)[number]
      | undefined;

    for (const session of sessions) {
      if (session.expiresAt.getTime() <= Date.now()) {
        await this.prisma.session.delete({ where: { id: session.id } });
        continue;
      }

      if (await argon2.verify(session.refreshTokenHash, refreshToken)) {
        matchedSession = session;
        break;
      }
    }

    if (!matchedSession) {
      throw new UnauthorizedException('Недействительный refresh-токен');
    }

    const payload: JwtPayload = {
      sub: userId,
      email: matchedSession.user.email,
      role: matchedSession.user.role,
    };
    const tokens = await this.signTokens(payload);

    await this.prisma.session.update({
      where: { id: matchedSession.id },
      data: {
        refreshTokenHash: await argon2.hash(tokens.refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return tokens;
  }

  private async signTokens(payload: JwtPayload): Promise<AuthTokens> {
    // jti делает каждый токен уникальным даже если пара выпускается в одну секунду
    // (иначе iat/exp совпадают и refresh-токен не меняется при ротации).
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { ...payload, jti: randomUUID() },
        { expiresIn: ACCESS_TOKEN_TTL },
      ),
      this.jwtService.signAsync(
        { ...payload, jti: randomUUID() },
        { expiresIn: REFRESH_TOKEN_TTL },
      ),
    ]);

    return { accessToken, refreshToken };
  }
}
