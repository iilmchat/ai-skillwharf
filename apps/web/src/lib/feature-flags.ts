/**
 * Флаги функций интерфейса. Значения вшиваются Vite на этапе сборки.
 *
 * RAG-память: контракт read-эндпоинта `GET /api/v1/chat/memory`
 * (`{ items: [{ id, content, createdAt }], total? }`) зафиксирован в
 * Sprint 14, но в текущей ветке API он ещё не выкачен (KI-023), поэтому
 * раздел «Память» скрыт и не делает запросов. Включать через
 * `VITE_RAG_MEMORY_ENABLED=true` после появления эндпоинта; для
 * Docker-сборки флаг пробрасывается build-arg'ом `VITE_RAG_MEMORY_ENABLED`
 * (см. `apps/web/Dockerfile`).
 */
export const RAG_MEMORY_PANEL_ENABLED =
  import.meta.env.VITE_RAG_MEMORY_ENABLED === 'true';
