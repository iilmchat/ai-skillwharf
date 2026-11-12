import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const passwordHash = await argon2.hash(dto.password);

    return this.prisma.user.create({
      data: { email: dto.email, passwordHash },
      select: { id: true, email: true },
    });
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
