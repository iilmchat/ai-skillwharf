import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assertInternalAuthConfig } from '@skillwharf/shared';
import { AppModule } from './app.module.js';
import { readWorkerConfig } from './config.js';

// SEC-26.1: в production пустой/короткий Internal secret — ошибка старта.
assertInternalAuthConfig();

const config = readWorkerConfig();
const app = await NestFactory.create(AppModule, {
  logger: ['error', 'warn', 'log'],
});

app.enableShutdownHooks();

await app.listen(config.port);

Logger.log(`llm-worker слушает порт ${config.port}`, 'Bootstrap');
