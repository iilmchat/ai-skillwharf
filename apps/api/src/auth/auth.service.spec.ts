import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'user@example.com';
const PASSWORD = 'password123';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  user: { findUnique: MockFn; create: MockFn };
  session: { create: MockFn };
}

interface JwtMock {
  signAsync: MockFn;
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let jwt: JwtMock;

  beforeEach(async () => {
    prisma = {
      user: { findUnique: vi.fn(), create: vi.fn() },
      session: { create: vi.fn() },
    };
    jwt = { signAsync: vi.fn() };

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
});
