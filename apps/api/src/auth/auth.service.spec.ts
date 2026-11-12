import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import type { JwtPayload } from './jwt.strategy.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';
const EMAIL = 'user@example.com';
const PASSWORD = 'password123';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  user: { findUnique: MockFn; create: MockFn };
  session: {
    create: MockFn;
    findMany: MockFn;
    update: MockFn;
    delete: MockFn;
  };
}

interface JwtMock {
  signAsync: MockFn;
  verifyAsync: MockFn;
}

function sessionRecord(
  overrides: {
    expiresAt?: Date;
    refreshTokenHash: string;
  },
) {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    refreshTokenHash: overrides.refreshTokenHash,
    user: { email: EMAIL, role: 'user' },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let jwt: JwtMock;

  beforeEach(async () => {
    prisma = {
      user: { findUnique: vi.fn(), create: vi.fn() },
      session: {
        create: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    jwt = { signAsync: vi.fn(), verifyAsync: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('хеширует пароль и создаёт пользователя', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(
        ({ data }: { data: { email: string; passwordHash: string } }) =>
          Promise.resolve({ id: USER_ID, email: data.email }),
      );

      const result = await service.register({ email: EMAIL, password: PASSWORD });

      expect(result).toEqual({ id: USER_ID, email: EMAIL });
      expect(prisma.user.create).toHaveBeenCalledTimes(1);

      const [{ data }] = prisma.user.create.mock.calls[0] as [
        { data: { email: string; passwordHash: string } },
      ];
      expect(data.email).toBe(EMAIL);
      expect(data.passwordHash).not.toBe(PASSWORD);
      await expect(argon2.verify(data.passwordHash, PASSWORD)).resolves.toBe(
        true,
      );
    });

    it('отклоняет регистрацию с занятым email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID });

      await expect(
        service.register({ email: EMAIL, password: PASSWORD }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('выдаёт токены и сохраняет хеш refresh-токена', async () => {
      const passwordHash = await argon2.hash(PASSWORD);
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: EMAIL,
        passwordHash,
        role: 'user',
      });
      jwt.signAsync
        .mockResolvedValueOnce('access-token')
        .mockResolvedValueOnce('refresh-token');
      prisma.session.create.mockResolvedValue({});

      const result = await service.login({ email: EMAIL, password: PASSWORD });

      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      expect(jwt.signAsync).toHaveBeenCalledTimes(2);

      const [payload] = jwt.signAsync.mock.calls[0] as [JwtPayload];
      expect(payload).toMatchObject({ sub: USER_ID, email: EMAIL, role: 'user' });

      expect(prisma.session.create).toHaveBeenCalledTimes(1);

      const [{ data }] = prisma.session.create.mock.calls[0] as [
        {
          data: {
            userId: string;
            refreshTokenHash: string;
            expiresAt: Date;
          };
        },
      ];
      expect(data.userId).toBe(USER_ID);
      expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await expect(
        argon2.verify(data.refreshTokenHash, 'refresh-token'),
      ).resolves.toBe(true);
    });

    it('отклоняет неверный пароль', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        role: 'user',
      });

      await expect(
        service.login({ email: EMAIL, password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('отклоняет вход несуществующего пользователя', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: EMAIL, password: PASSWORD }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refreshTokens', () => {
    it('ротирует пару токенов и обновляет сессию', async () => {
      prisma.session.findMany.mockResolvedValue([
        sessionRecord({ refreshTokenHash: await argon2.hash('old-refresh') }),
      ]);
      jwt.signAsync
        .mockResolvedValueOnce('new-access-token')
        .mockResolvedValueOnce('new-refresh-token');
      prisma.session.update.mockResolvedValue({});

      const result = await service.refreshTokens(USER_ID, 'old-refresh');

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      const [payload] = jwt.signAsync.mock.calls[0] as [JwtPayload];
      expect(payload).toMatchObject({ sub: USER_ID, email: EMAIL, role: 'user' });

      expect(prisma.session.update).toHaveBeenCalledTimes(1);
      const [{ where, data }] = prisma.session.update.mock.calls[0] as [
        {
          where: { id: string };
          data: { refreshTokenHash: string; expiresAt: Date };
        },
      ];
      expect(where).toEqual({ id: SESSION_ID });
      expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await expect(
        argon2.verify(data.refreshTokenHash, 'new-refresh-token'),
      ).resolves.toBe(true);
    });

    it('отклоняет токен, которого нет ни в одной сессии', async () => {
      prisma.session.findMany.mockResolvedValue([
        sessionRecord({ refreshTokenHash: await argon2.hash('other-token') }),
      ]);

      await expect(
        service.refreshTokens(USER_ID, 'unknown-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.session.update).not.toHaveBeenCalled();
    });

    it('удаляет истёкшие сессии и отклоняет запрос', async () => {
      prisma.session.findMany.mockResolvedValue([
        sessionRecord({
          expiresAt: new Date(Date.now() - 60_000),
          refreshTokenHash: await argon2.hash('old-refresh'),
        }),
      ]);
      prisma.session.delete.mockResolvedValue({});

      await expect(
        service.refreshTokens(USER_ID, 'old-refresh'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.session.delete).toHaveBeenCalledWith({
        where: { id: SESSION_ID },
      });
      expect(prisma.session.update).not.toHaveBeenCalled();
    });
  });

  describe('verifyRefreshToken', () => {
    it('возвращает payload валидного токена', async () => {
      const payload: JwtPayload = { sub: USER_ID, email: EMAIL, role: 'user' };
      jwt.verifyAsync.mockResolvedValue(payload);

      await expect(service.verifyRefreshToken('token')).resolves.toEqual(
        payload,
      );
    });

    it('отклоняет токен с неверной подписью', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));

      await expect(
        service.verifyRefreshToken('token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
