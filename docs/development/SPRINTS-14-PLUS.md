# Sprints 14+ — Пилот: единый источник истины

**Статус:** Утверждено
**Дата:** 2026-11-13
**Заменяет:** разделы Sprint 13+ в `POST-MVP-TODO.md` и `ROADMAP.md`

## 0. Зафиксированные решения

- Пилот охватывает **все 10 треков (A–J)**.
- Реплики API в пилоте: **2+** (rolling deploy, переживание рестарта).
- **Firecracker** — post-pilot. Для пилота достаточно `sandbox-worker` + seccomp + FQDN egress.
- **1С** — post-pilot (в пилоте нет клиента с 1С).
- **Дзен (трек F)** — официальное ограничение пилота: Markdown-черновик + ручная загрузка через HITL.
- **Telegram / Google Workspace** — не рискуем качеством: отдельные спринты (18 и 19).
- **KI-нумерация:** занято до KI-024 включительно. Новые проблемы — с KI-025.

## 1. Правила

- Каждый спринт обновляет `CHANGELOG.md` (`[Unreleased]`) и `docs/KNOWN_ISSUES.md` в том же изменении.
- Любая проблема получает ID, влияние, обход и план.
- Крупные архитектурные решения — ADR в `docs/architecture/ADR/`.
- Коммиты — Conventional Commits. `git add -A` запрещён.
- Перед пушем: `pnpm lint`, `pnpm test`, `pnpm build:api`, `pnpm lint:docs`.

## 2. Sprint 14 — Policy-as-Code & Egress

**Цель:** закрыть эксфильтрацию и уйти от regex-защиты.

| Задача | Закрывает |
|---|---|
| `AgentGateway` → декларативный policy engine (schema-based validation, allowlist команд, taint tracking, роли/контекст) | KI-013, ADR 0004 п.2 |
| FQDN-aware egress: `egress_allowlist` из манифеста → egress-gateway с allowlist доменов; без allowlist — блок | KI-008, ADR 0004 п.3 |
| MCP Gateway как отдельный слой проверки вызовов `ozon_mcp_call`/`wb_mcp_call` | ADR 0004 п.1–2 |
| Кастомный seccomp-профиль для `sandbox-worker` | KI-005 |
| `GET /api/v1/chat/memory` (read-API для RAG) + Zod-контракт `{ items: [{ id, content, createdAt }], total? }` | KI-023 |
| WS-ошибка: фронтенд переходит на `code` вместо текста | отчёт OpenCode |
| Проброс `VITE_RAG_MEMORY_ENABLED` как build-arg в `apps/web/Dockerfile` | KI-023 (UI-часть) |

**DoD:** egress без allowlist блокируется; обходы `rm -rf`/`eval`/`curl|sh` ловятся политикой, а не regex; seccomp применён в staging; read-API памяти отдаёт данные, UI показывает панель; `pnpm lint/test/build:api/lint:docs` зелёные; тесты на обход зелёные.

## 3. Sprint 15 — Pilot Reliability

**Цель:** 2 реплики API без гонок, HITL переживает рестарт, деньги не списываются некорректно.

| Задача | Закрывает |
|---|---|
| Init-container для `prisma migrate deploy`; реплики API стартуют без миграций | KI-007 |
| LangGraph Checkpointer в PostgreSQL: `waiting_approval` и escrow-hold переживают рестарт | ROADMAP Sprint 11 |
| Резервирование токенов до вызова LLM с последующим reconcile (вместо проверки после генерации) | KI-021 |
| Fallback-токенизатор, если GigaChat не прислал usage в стриме | KI-022 |
| Offsite-бэкапы (S3-совместимое хранилище) + restore-drill | KI-019 |
| Периодический сброс Freemium-лимитов | ROADMAP Sprint 7 |
| Пагинация истории транзакций | ROADMAP Sprint 7 |

**DoD:** 2 реплики стартуют без гонки; `docker compose restart api` не теряет pending approval; KI-021/022 закрыты тестами; offsite-бэкап восстанавливается на чистой БД.

## 4. Sprint 16 — LLM Router v2 & AgentOps

| Задача | Закрывает |
|---|---|
| Fallback-цепочки, budget guardrails, классификация задач в `LlmRouter` | KI-010 |
| OTel-коллектор + Sentry; спаны `gen_ai.*` по `AgentOps-Specification.md` | AgentOps Spec |
| Cost attribution по `gen_ai.tenant.id` в Grafana | Control Plane Блок 4 |

## 5. Sprint 17 — LLM Worker & Queues

| Задача | Закрывает |
|---|---|
| LangChain/LangGraph → отдельный LLM-воркер (Spoke) | KI-006 |
| Redis/BullMQ для фоновых задач | ROADMAP Sprint 12 |
| Нагрузочное тестирование 2+ реплик | POST-MVP п. Sprint 12 |

**DoD:** образ API ≤ 400 МБ; фоновые задачи не блокируют HTTP; выдержан N RPS.

## 6. Sprint 18 — Telegram + Google Workspace

Разблокирует треки **A, B, C, E, G**.

| Задача | Треки |
|---|---|
| Реальный Telegram Bot API вместо `send_message` mock | A, B, C, E, G |
| Реальный Google Workspace (Sheets, Docs, Calendar) через OAuth | A, E, G |
| Верификация Ozon/WB MCP в staging; закрыть KI-011 | C, J |

## 7. Sprint 19 — Ozon/WB Finance + Midjourney

Разблокирует **C, D, J**.

| Задача | Треки |
|---|---|
| Реальный `unit-economics` на данных Ozon/WB | J |
| `profit-leak-detector`, `price-monitor` на реальных данных | J |
| `fraud-shield-audit` (UTM, ERID, договоры) | J |
| Midjourney API | D |
| Кросс-площадочная аналитика | C |

**Закрывает KI-015 полностью.**

## 8. Sprint 20 — Документы + HR + Content

Разблокирует **F, G, H, I**.

| Задача | Треки |
|---|---|
| `pdf-extractor`, `docx-writer` | H, I |
| OCR Smart Document Engine | H, I |
| `document-analyzer` (реальный RAG по документам) | H, I |
| `fact-checker` (реальные источники) | F |
| `resume-screener` (HR/ATS) | G |

**Закрывает KI-014 и остаток KI-012.**

## 9. Sprint 21 — Pilot Launch

- Запуск всех 10 треков на 2+ репликах.
- Сбор обратной связи, hot-fix.
- A/B-тестирование промптов (KI-009) — если успеваем, иначе post-pilot.

## 10. Post-pilot (Sprints 22+)

| Спринт | Тема |
|---|---|
| 22 | Firecracker (ADR 0002/0005), gVisor fallback для K8s |
| 23 | Публичный реестр, Ed25519-подписи, Revenue Share 85/15 |
| 24 | Marketplace UI, A/B промптов (если не в 21) |
| 25+ | SSO/LDAP для мониторинга (KI-018), метаданные памяти (KI-024), 1С, white-label |

## 11. Блокеры и ограничения пилота

| Ограничение | Трек | Решение |
|---|---|---|
| Нет публичного API Дзена | F | Markdown + ручная загрузка через HITL (официально) |
| Нет 1С | H, J | Post-pilot |
| OCR Smart Document Engine | H, I | Начать переговоры/получить ключи до Sprint 20; fallback — Tesseract |