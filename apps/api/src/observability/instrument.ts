/**
 * Инициализация observability должна выполняться до загрузки Nest-модулей:
 * Sentry перехватывает необработанные исключения, а OTel SDK регистрирует
 * инструментации HTTP/Nest. Файл импортируется первым в main.ts.
 */
import { initSentry } from './sentry.js';
import { startTracing } from './tracing.js';

initSentry();
startTracing();
