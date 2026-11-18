import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // NestJS-скелет генерирует тесты с суффиксом .spec.ts.
      'apps/*/src/**/*.spec.ts',
      // Контрактный E2E HITL/Ledger (QA-24.4) самодостаточен: in-memory Prisma
      // и mock LLM-worker, внешние сервисы не нужны. Остальные e2e-тесты
      // приложения запускаются отдельно через `test:e2e`.
      'apps/api/test/agent-hitl-billing.e2e-spec.ts',
    ],
  },
});
