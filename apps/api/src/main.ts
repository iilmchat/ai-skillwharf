import './observability/instrument.js';

import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { MetricsService } from './metrics/metrics.service.js';
import { isSentryEnabled } from './observability/sentry.js';
import { shutdownTracing } from './observability/tracing.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Sentry перехватывает необработанные исключения, сохраняя JSON-формат
  // Nest. Без DSN фильтр не регистрируется.
  if (isSentryEnabled()) {
    app.useGlobalFilters(
      new SentryGlobalFilter(app.get(HttpAdapterHost).httpAdapter),
    );
  }


  // За Caddy реальный IP приходит в X-Forwarded-For; без этого throttler
  // считал бы все запросы с одного IP reverse-proxy.
  app.set('trust proxy', 1);
  app.use(helmet());

  // http_requests_total считаем по шаблону маршрута, а не по URL: иначе
  // каждый id в пути создавал бы новую серию метрик.
  const metrics = app.get(MetricsService);
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.on('finish', () => {
      const route = request.route?.path
        ? `${request.baseUrl}${request.route.path}`
        : 'unmatched';

      metrics.observeHttpRequest(request.method, route, response.statusCode);
    });

    next();
  });
  app.enableCors({
    origin: ['http://localhost:8080'],
    credentials: true,
  });
  // /metrics вне префикса: Prometheus скрейпит его по короткому пути.
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Даём OTel SDK экспортировать буфер при штатном завершении контейнера.
  process.once('SIGTERM', () => {
    void shutdownTracing();
  });

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
