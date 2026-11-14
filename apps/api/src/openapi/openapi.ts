import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

/**
 * Swagger UI живёт вне global prefix приложения.
 *
 * Эндпоинты API доступны по `/api/v1/...`, а документация — по `/api/docs`
 * (JSON — `/api/docs-json`), как того требует контракт проекта.
 */
export const OPENAPI_DOCS_PATH = 'api/docs';

/** Имя security scheme; совпадает с именем по умолчанию у `@ApiBearerAuth()`. */
export const OPENAPI_BEARER_AUTH = 'bearer';

const API_DESCRIPTION = [
  'REST API SkillWharf: аутентификация, чат с агентом, биллинг,',
  'интеграции с внешними провайдерами и финансовый дашборд.',
  '',
  'Защищённые методы принимают access token из `POST /api/v1/auth/login`',
  'в заголовке `Authorization: Bearer <token>`.',
].join('\n');

/**
 * Собирает OpenAPI-документ из декораторов контроллеров.
 *
 * Генерация работает только с метаданными Nest и не обращается к БД:
 * `SwaggerModule.createDocument` не вызывает методы контроллеров.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('SkillWharf API')
    .setDescription(API_DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token из POST /api/v1/auth/login',
      },
      OPENAPI_BEARER_AUTH,
    )
    .addTag('Auth', 'Регистрация, вход, обновление токенов и профиль')
    .addTag('Chat', 'Диалоги, память, HITL-подтверждения')
    .addTag('Billing', 'Баланс, история операций и платежи')
    .addTag('Integrations', 'Telegram, Google, Ozon, Wildberries, Midjourney')
    .addTag('Finance', 'Финансовый дашборд и результаты инструментов')
    .build();

  return SwaggerModule.createDocument(app, config);
}

/**
 * Монтирует Swagger UI по `OPENAPI_DOCS_PATH`.
 *
 * Вызывается после `setGlobalPrefix`, чтобы пути в документе содержали
 * `/api/v1`. Настройки `persistAuthorization` сохраняют JWT между
 * перезагрузками страницы Swagger UI.
 */
export function setupOpenApi(app: INestApplication): void {
  const document = createOpenApiDocument(app);

  SwaggerModule.setup(OPENAPI_DOCS_PATH, app, document, {
    customSiteTitle: 'SkillWharf API',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  });
}
