/**
 * Флаги функций интерфейса. Значения вшиваются Vite на этапе сборки.
 *
 * RAG-память: read-endpoint `GET /api/v1/chat/memory` ещё не реализован в API
 * (см. `docs/KNOWN_ISSUES.md`, KI-023), поэтому раздел «Память» скрыт и не
 * делает запросов. Включать через `VITE_RAG_MEMORY_ENABLED=true` только после
 * появления эндпоинта и проверки контракта; для Docker-сборки понадобится
 * проброс build-arg в `apps/web/Dockerfile`.
 */
export const RAG_MEMORY_PANEL_ENABLED =
  import.meta.env.VITE_RAG_MEMORY_ENABLED === 'true';
