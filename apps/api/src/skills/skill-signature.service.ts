import { Injectable, Logger } from '@nestjs/common';
import {
  findTrustedKey,
  parseTrustedSkillPublicKeys,
  verifySkillSignature,
  type SkillManifest,
  type TrustedSkillPublicKey,
} from '@skillwharf/shared';
import { invalidSkillSignatureError } from '../common/api-error.js';
import { parseSkillFile } from './skill-file.js';

/** Результат проверки подписи при публикации/установке навыка. */
export interface SkillSignatureReport {
  /** Подпись присутствует и прошла проверку. */
  readonly verified: boolean;
  readonly signed: boolean;
  readonly keyId?: string;
}

/**
 * Проверка Ed25519-подписи SKILL.md (API-27.1).
 *
 * Доверенные ключи задаются в `TRUSTED_SKILL_PUBLIC_KEYS` (JSON-объект/массив
 * или CSV `keyId:base64`). Политика `REQUIRE_SIGNED_SKILLS=true` запрещает
 * установку неподписанных навыков; по умолчанию выключена для совместимости с
 * локальными/стартовыми навыками.
 */
@Injectable()
export class SkillSignatureService {
  private readonly logger = new Logger(SkillSignatureService.name);
  private readonly keys: readonly TrustedSkillPublicKey[];
  private readonly requireSigned: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.keys = parseTrustedSkillPublicKeys(env.TRUSTED_SKILL_PUBLIC_KEYS);
    this.requireSigned = (env.REQUIRE_SIGNED_SKILLS ?? '').trim() === 'true';
  }

  /** Проверяет манифест и body, бросая `errors.invalid_skill_signature`. */
  verify(fileContent: string): SkillSignatureReport {
    const parsed = parseSkillFile(fileContent);

    if (!parsed.success) {
      throw invalidSkillSignatureError(
        `Некорректный SKILL.md: ${parsed.errors.join('; ')}`,
      );
    }

    return this.verifyParsed(parsed.value.manifest, parsed.value.body);
  }

  /** Проверка уже разобранного файла (используется при публикации). */
  verifyParsed(
    manifest: SkillManifest,
    body: string,
  ): SkillSignatureReport {
    if (manifest.signature === undefined) {
      if (this.requireSigned) {
        throw invalidSkillSignatureError(
          'Навык должен быть подписан (REQUIRE_SIGNED_SKILLS=true)',
        );
      }

      return { verified: false, signed: false };
    }

    if (manifest.publicKeyId === undefined) {
      throw invalidSkillSignatureError(
        'Для подписи не указан publicKeyId',
      );
    }

    const trusted = findTrustedKey(this.keys, manifest.publicKeyId);

    if (trusted === undefined) {
      throw invalidSkillSignatureError(
        `Неизвестный keyId: ${manifest.publicKeyId}`,
      );
    }

    const ok = verifySkillSignature(
      { manifest, body },
      manifest.signature,
      trusted.publicKey,
    );

    if (!ok) {
      this.logger.warn(
        JSON.stringify({ event: 'skill.signature_invalid', keyId: trusted.keyId }),
      );
      throw invalidSkillSignatureError('Ed25519-подпись SKILL.md недействительна');
    }

    return { verified: true, signed: true, keyId: trusted.keyId };
  }

  /** Проверка перед установкой: fail closed при невалидной подписи. */
  assertInstallable(fileContent: string): SkillSignatureReport {
    return this.verify(fileContent);
  }

  /** Список keyId доверенных ключей (для диагностики, без значений ключей). */
  trustedKeyIds(): readonly string[] {
    return this.keys.map((key) => key.keyId);
  }
}
