// CLI ротации ключей шифрования (SEC-26.2 / KI-053).
// Импортирует собранные модули dist: в исходниках есть декораторы Nest,
// которые Node не умеет загружать через --experimental-transform-types.
import { PrismaClient } from '@prisma/client';
import { TokenCipherService } from '../dist/integrations/google/token-cipher.service.js';
import { CredentialRotationService } from '../dist/integrations/keys/credential-rotation.service.js';

const prisma = new PrismaClient();

try {
  const cipher = new TokenCipherService();

  if (!cipher.isConfigured()) {
    throw new Error('TOKEN_ENCRYPTION_KEY не задан или некорректен');
  }

  const rotation = new CredentialRotationService(prisma, cipher);
  const report = await rotation.rotateAllCredentials();

  console.log(JSON.stringify({ event: 'credentials.key_rotated', ...report }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`keys:rotate: ${message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
