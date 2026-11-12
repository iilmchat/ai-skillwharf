import { Prisma, PrismaClient } from '@prisma/client';
import { SkillManifestSchema } from '@skillwharf/shared';
import * as argon2 from 'argon2';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'admin@skillwharf.ru';
const ADMIN_PASSWORD = 'admin123';
const DEMO_TOP_UP = new Prisma.Decimal(5000);
const DEMO_LLM_ROUTE = {
  name: 'local-qwen',
  modelName: 'qwen2.5-coder-7b-instruct',
  baseUrl: 'http://host.docker.internal:8034/v1',
  apiKeyEnvVar: 'LLM_API_KEY',
};

/** YAML frontmatter: блок между первыми строками `---`. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

interface DemoUser {
  id: string;
  email: string;
}

async function seedAdmin(): Promise<DemoUser> {
  const passwordHash = await argon2.hash(ADMIN_PASSWORD);

  return prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { passwordHash, role: 'admin' },
    create: {
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'admin',
    },
    select: { id: true, email: true },
  });
}

async function seedWallet(userId: string): Promise<void> {
  const wallet = await prisma.wallet.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const idempotencyKey = `demo-seed-credit-${userId}`;
  const existing = await prisma.ledgerEntry.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });

  if (existing) {
    console.log('ℹ️  Демо-пополнение уже применено, пропускаем.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: DEMO_TOP_UP } },
    });

    await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        amount: DEMO_TOP_UP,
        balanceAfter: updated.balance,
        type: 'credit',
        description: 'Демо-пополнение для презентации',
        idempotencyKey,
      },
    });
  });
}

async function seedLlmRoute(): Promise<void> {
  await prisma.llmRoute.updateMany({
    where: { name: { not: DEMO_LLM_ROUTE.name }, isActive: true },
    data: { isActive: false },
  });
  await prisma.llmRoute.upsert({
    where: { name: DEMO_LLM_ROUTE.name },
    update: {
      ...DEMO_LLM_ROUTE,
      priority: 0,
      isActive: true,
    },
    create: {
      ...DEMO_LLM_ROUTE,
      priority: 0,
      isActive: true,
    },
  });
}

async function seedStarterSkills(): Promise<string[]> {
  const starterDir = fileURLToPath(
    new URL('../../../starter-skills/', import.meta.url),
  );
  const files = globSync('**/SKILL.md', { cwd: starterDir }).sort();
  const installed: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(starterDir, file), 'utf8');
    const frontmatter = FRONTMATTER_PATTERN.exec(content);

    if (!frontmatter?.[1]) {
      throw new Error(`В ${file} не найден YAML frontmatter`);
    }

    const parsed = SkillManifestSchema.safeParse(parse(frontmatter[1]));

    if (!parsed.success) {
      const errors = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');

      throw new Error(`Некорректный манифест ${file}: ${errors}`);
    }

    const manifest = parsed.data;

    await prisma.installedSkill.upsert({
      where: { name: manifest.name },
      create: {
        name: manifest.name,
        version: manifest.version,
        author: manifest.author.name,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        isEnabled: true,
      },
      update: {
        version: manifest.version,
        author: manifest.author.name,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        isEnabled: true,
      },
    });
    installed.push(manifest.name);
  }

  return installed.sort();
}

async function main(): Promise<void> {
  const user = await seedAdmin();
  await seedWallet(user.id);
  await seedLlmRoute();
  const skills = await seedStarterSkills();
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { userId: user.id },
    select: { balance: true, heldBalance: true },
  });

  console.log('');
  console.log('✅ Демо-данные готовы');
  console.log(`   Админ: ${user.email} / ${ADMIN_PASSWORD}`);
  console.log(
    `   Баланс: ${wallet.balance.toFixed(2)} ₽ (held: ${wallet.heldBalance.toFixed(2)} ₽)`,
  );
  console.log(
    `   LLM-роут: ${DEMO_LLM_ROUTE.name} → ${DEMO_LLM_ROUTE.modelName} (${DEMO_LLM_ROUTE.baseUrl})`,
  );
  console.log(`   Навыки (${skills.length}): ${skills.join(', ')}`);
}

main()
  .catch((error: unknown) => {
    console.error('❌ Не удалось заполнить демо-данные:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
