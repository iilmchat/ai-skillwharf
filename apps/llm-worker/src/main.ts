import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { readWorkerConfig } from './config.js';

const config = readWorkerConfig();
const app = await NestFactory.create(AppModule, {
  logger: ['error', 'warn', 'log'],
});

app.enableShutdownHooks();

await app.listen(config.port);

Logger.log(`llm-worker слушает порт ${config.port}`, 'Bootstrap');
