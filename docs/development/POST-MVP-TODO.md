# Roadmap: Переход от MVP к Production (Post-MVP)

**Статус:** Заменён на [SPRINTS-14-PLUS.md](SPRINTS-14-PLUS.md)
**Дата:** 2026-11-13

Файл сохранён для истории. Актуальный план с Sprint 14 — в [SPRINTS-14-PLUS.md](SPRINTS-14-PLUS.md).

## Что было запланировано здесь и уже сделано

- **Sprint 9 (Production Readiness):** Auth rate-limit, helmet, CORS, восстановление refresh-токена в UI, `sandbox-worker` (без Docker Socket в API), admin-only `topup`, Cost Guardrails (жёсткий дневной лимит токенов), верификация вебхуков ЮKassa через реальный API — **сделано**.
- **Sprint 10 (Real tools):** адаптеры GigaChat и YandexGPT, LLM Router CRUD, реальные MCP-серверы Ozon/WB (KI-011 закрыт) — **сделано**. Дзен-публикация осталась ограничением пилота (Markdown + ручная загрузка).
- **Sprint 11 (Scaling & Memory):** pgvector для долговременной памяти, `sandbox-worker` — **сделано**. LangGraph Checkpointer — **в Sprint 15** (см. SPRINTS-14-PLUS.md).
- **Sprint 12 (Observability):** Prometheus + Grafana с Basic Auth, ротация бэкапов — **сделано**. OTel/Sentry — **в Sprint 16**; Redis/BullMQ — **в Sprint 17**; offsite-бэкапы и restore-drill — **в Sprint 15**.
- **Sprint 13 (Ecosystem):** публичный реестр, Ed25519, Revenue Share 85/15 — **post-pilot (Sprint 23)**.
- **Sprint 13 (фактический, хвосты перед пилотом):** Basic Auth для мониторинга, ротация бэкапов, атомарный жёсткий лимит токенов, стриминг GigaChat, RAG-панель за feature-флагом — **сделано**.
