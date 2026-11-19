import { Injectable, Logger } from '@nestjs/common';
import { providerNotConfiguredError } from '../../common/api-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCipherService } from '../google/token-cipher.service.js';

/** Счётчики перешифрованных записей по моделям. */
export interface CredentialRotationReport {
  readonly providerCredentials: number;
  readonly googleCredentials: number;
  readonly telegramBots: number;
  readonly total: number;
}

/**
 * Ротация ключей шифрования секретов (SEC-26.2 / KI-053).
 *
 * Перешифровывает envelope `v1:*` и `v2:<другой keyId>` на активный ключ.
 * Чтение старых значений идёт через `TOKEN_ENCRYPTION_PREVIOUS_KEYS`.
 * Все обновления выполняются в одной транзакции: ошибка расшифровки любой
 * записи откатывает всю ротацию (fail closed, без частично перешифрованной БД).
 */
@Injectable()
export class CredentialRotationService {
  private readonly logger = new Logger(CredentialRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
  ) {}

  async rotateAllCredentials(): Promise<CredentialRotationReport> {
    if (this.cipher.providerName === 'local' && !this.cipher.isConfigured()) {
      throw providerNotConfiguredError(
        'Ротация ключей недоступна: задайте TOKEN_ENCRYPTION_KEY (base64, 32 байта)',
      );
    }

    const [providers, google, telegram] = await Promise.all([
      this.prisma.providerCredential.findMany({
        select: { userId: true, provider: true, secret: true },
      }),
      this.prisma.googleCredential.findMany({
        select: { userId: true, accessToken: true, refreshToken: true },
      }),
      this.prisma.telegramBot.findMany({
        select: { userId: true, token: true },
      }),
    ]);

    let providerCredentials = 0;
    let googleCredentials = 0;
    let telegramBots = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const row of providers) {
        const secret = await this.rotateValue(row.secret);

        if (secret === null) {
          continue;
        }

        await tx.providerCredential.update({
          where: {
            userId_provider: { userId: row.userId, provider: row.provider },
          },
          data: { secret },
        });
        providerCredentials += 1;
      }

      for (const row of google) {
        const accessToken = await this.rotateValue(row.accessToken);
        const refreshToken =
          row.refreshToken === null ? null : await this.rotateValue(row.refreshToken);

        if (accessToken === null && refreshToken === null) {
          continue;
        }

        await tx.googleCredential.update({
          where: { userId: row.userId },
          data: {
            ...(accessToken === null ? {} : { accessToken }),
            ...(refreshToken === null ? {} : { refreshToken }),
          },
        });
        googleCredentials += 1;
      }

      for (const row of telegram) {
        const token = await this.rotateValue(row.token);

        if (token === null) {
          continue;
        }

        await tx.telegramBot.update({
          where: { userId: row.userId },
          data: { token },
        });
        telegramBots += 1;
      }
    });

    const report: CredentialRotationReport = {
      providerCredentials,
      googleCredentials,
      telegramBots,
      total: providerCredentials + googleCredentials + telegramBots,
    };
    this.logger.log(
      JSON.stringify({ event: 'credentials.key_rotated', ...report }),
    );

    return report;
  }

  /**
   * null — запись уже у активного провайдера/ключа; ошибка расшифровки
   * пробрасывается. Поддерживает миграцию v1/v2 → kms:vault / kms:yandex.
   */
  private async rotateValue(envelope: string): Promise<string | null> {
    if (!this.cipher.needsEnvelopeRotation(envelope)) {
      return null;
    }

    const plaintext = await this.cipher.decryptEnvelope(envelope);

    return this.cipher.encryptEnvelope(plaintext);
  }
}
