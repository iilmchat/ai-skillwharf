/**
 * Окружение для экспорта OpenAPI.
 *
 * Генератор документа не обращается к БД и фоновым job'ам, поэтому не должен
 * зависеть от локального `.env`. JWT_SECRET нужен только стратегии Passport
 * при инициализации DI; сам токен при экспорте не выпускается.
 */
process.env.JWT_SECRET ??= 'openapi-export-placeholder';

// Пустая БД и Redis: onModuleInit-сервисы штатно логируют недоступность и
// продолжают работу, а Swagger строит документ из метаданных контроллеров.
delete process.env.DATABASE_URL;
process.env.REDIS_URL = '';
