import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { z } from 'zod';
import type { SkillManifest } from './skill-manifest.js';
import {
  skillPublicKeyIdSchema,
  skillSignatureSchema,
} from './skill-manifest.js';

/**
 * Ed25519-подпись манифестов SKILL.md (Sprint 27 / API-27.1).
 *
 * Подписывается не «как написано в файле», а каноническое представление:
 * ключи сортируются рекурсивно, `signature` исключается, а тело SKILL.md
 * входит отдельным полем. Это убирает расхождения в пробелах и порядке
 * ключей между подписью и проверкой.
 */

export const SKILL_SIGNATURE_PREFIX = 'ed25519:';

/** Что именно подписывается. */
export interface SkillSigningPayload {
  readonly manifest: SkillManifest;
  /** Markdown Body между закрывающим `---` и концом файла. */
  readonly body: string;
}

/** Пара ключей в base64 (для env/CLI). */
export interface SkillKeyPair {
  /** DER (SPKI) в base64 — публикуется в реестре доверенных ключей. */
  readonly publicKey: string;
  /** DER (PKCS#8) в base64 — хранится только у издателя. */
  readonly privateKey: string;
}

const keyPairSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});

/** Стабильная сериализация: сортировка ключей на всех уровнях объекта. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Каноническая строка, которая подаётся в Ed25519. */
export function canonicalSkillPayload(payload: SkillSigningPayload): string {
  // `signature` и `publicKeyId` добавляются в frontmatter уже после подписи,
  // поэтому они не входят в подписываемое представление.
  const {
    signature: _signature,
    publicKeyId: _publicKeyId,
    ...manifest
  } = payload.manifest;

  return canonicalJson({
    manifest,
    body: payload.body,
  });
}

/** Создаёт тестовую/издательскую пару Ed25519-ключей. */
export function generateSkillKeyPair(): SkillKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  return keyPairSchema.parse({
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
  });
}

/** Подписывает манифест; возвращает строку `ed25519:<base64>`. */
export function signSkillManifest(
  payload: SkillSigningPayload,
  privateKeyBase64: string,
): string {
  const key = z.string().min(1).parse(privateKeyBase64);
  const privateKey = createPrivateKey({
    key: Buffer.from(key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = signBytes(
    null,
    Buffer.from(canonicalSkillPayload(payload), 'utf8'),
    privateKey,
  );

  return `${SKILL_SIGNATURE_PREFIX}${signature.toString('base64')}` as z.infer<
    typeof skillSignatureSchema
  >;
}

/** Проверяет подпись. Ошибки ключа/формата трактуются как отказ. */
export function verifySkillSignature(
  payload: SkillSigningPayload,
  signature: string,
  publicKeyBase64: string,
): boolean {
  const parsedSignature = skillSignatureSchema.safeParse(signature);
  const key = z.string().min(1).safeParse(publicKeyBase64);

  if (!parsedSignature.success || !key.success) {
    return false;
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.data, 'base64'),
      format: 'der',
      type: 'spki',
    });

    return verifyBytes(
      null,
      Buffer.from(canonicalSkillPayload(payload), 'utf8'),
      publicKey,
      Buffer.from(parsedSignature.data.slice(SKILL_SIGNATURE_PREFIX.length), 'base64'),
    );
  } catch {
    return false;
  }
}

/** Один доверенный ключ издателя: `keyId` + base64 SPKI. */
export interface TrustedSkillPublicKey {
  readonly keyId: z.infer<typeof skillPublicKeyIdSchema>;
  readonly publicKey: string;
}

const publicKeyMaterialSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'публичный ключ должен быть base64')
  .refine((value) => Buffer.from(value, 'base64').length > 0, {
    message: 'публичный ключ не должен быть пустым',
  });

const trustedObjectSchema = z.object({
  keyId: skillPublicKeyIdSchema,
  publicKey: publicKeyMaterialSchema,
});

const trustedJsonSchema = z.union([
  z.array(trustedObjectSchema),
  z.record(skillPublicKeyIdSchema, publicKeyMaterialSchema).transform((record) =>
    Object.entries(record).map(([keyId, publicKey]) => ({ keyId, publicKey })),
  ),
]);

/**
 * Парсит реестр доверенных ключей из env. Два формата:
 *   JSON: {"author-key":"<base64>"} или [{"keyId":"author-key","publicKey":"..."}]
 *   CSV:  author-key:<base64>,other-key:<base64>
 * Невалидная запись — ошибка (fail closed), а не молчаливый пропуск.
 */
export function parseTrustedSkillPublicKeys(
  raw: string | undefined,
): readonly TrustedSkillPublicKey[] {
  const source = (raw ?? '').trim();

  if (source === '') {
    return [];
  }

  let entries: readonly TrustedSkillPublicKey[];

  if (source.startsWith('{') || source.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      throw new Error('TRUSTED_SKILL_PUBLIC_KEYS: некорректный JSON');
    }

    const result = trustedJsonSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(
        `TRUSTED_SKILL_PUBLIC_KEYS: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    entries = result.data;
  } else {
    const candidates = source.split(',').map((item) => {
      const separator = item.indexOf(':');

      return { keyId: item.slice(0, separator), publicKey: item.slice(separator + 1) };
    });
    const result = z.array(trustedObjectSchema).safeParse(candidates);

    if (!result.success) {
      throw new Error(
        `TRUSTED_SKILL_PUBLIC_KEYS: ${result.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }

    entries = result.data;
  }

  return entries;
}

/** Ищет публичный ключ по `publicKeyId` реестра. */
export function findTrustedKey(
  keys: readonly TrustedSkillPublicKey[],
  publicKeyId: string | undefined,
): TrustedSkillPublicKey | undefined {
  if (publicKeyId === undefined) {
    return undefined;
  }

  const parsed = skillPublicKeyIdSchema.safeParse(publicKeyId);

  if (!parsed.success) {
    return undefined;
  }

  return keys.find((key) => key.keyId === parsed.data);
}
