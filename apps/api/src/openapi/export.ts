import './export-env.js';

import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../app.module.js';
import { createOpenApiDocument } from './openapi.js';

/** Корень монорепозитория: скрипт запускается из `apps/api`. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Куда пишется документ по умолчанию: `docs/openapi/swagger.json`. */
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'docs/openapi/swagger.json');

/**
 * Экспортирует OpenAPI-документ в JSON для Postman, Insomnia и codegen.
 *
 * Запуск: `pnpm run openapi:export` (из корня) или
 * `pnpm --filter api openapi:export`. Необязательный аргумент — путь к файлу
 * относительно корня монорепозитория.
 */
async function exportOpenApi(): Promise<void> {
  const requestedPath = process.argv[2];
  const outputPath =
    requestedPath === undefined
      ? DEFAULT_OUTPUT
      : resolve(process.cwd(), requestedPath);

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });

  try {
    const document = createOpenApiDocument(app);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    process.stdout.write(`OpenAPI: ${outputPath}\n`);
  } finally {
    await app.close();
  }
}

await exportOpenApi();
