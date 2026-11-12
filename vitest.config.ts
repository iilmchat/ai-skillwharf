import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // NestJS-скелет генерирует тесты с суффиксом .spec.ts.
      'apps/*/src/**/*.spec.ts',
    ],
  },
});
