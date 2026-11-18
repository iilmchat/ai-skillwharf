# Product & Engineering Roadmap — SkillWharf

**Текущая версия:** `v0.2.0-pilot` (Спринты 1–22 завершены, идёт **Sprint 23**)
**Методология:** Stage-Gate (Релизы) -> Sprints (2-недельные итерации) -> Atomic Tasks.
**Правило для AI-агентов (обязательно):**

1. При завершении задачи меняй `[ ]` на `[x]` и указывай ID коммита/PR.
2. Если задача заблокирована или выявлен баг — ставь `[!]` и заноси запись в раздел **«Журнал выполнения и блокеров»** с присвоением `KI-XXX` в `docs/KNOWN_ISSUES.md`.
3. Не удаляй закрытые этапы — они служат аудиторским следом.

---

## Этап 0: MVP & Pilot Foundation (`v0.1.0` – `v0.2.0-pilot`) — ЗАВЕРШЕНО

* **Sprint 1–6:** Ядро NestJS/Fastify, Prisma/PostgreSQL, JWT + RBAC, Docker `sandbox-worker` (ADR 0005), append-only Ledger + BAL, каталог `SKILL.md`.
* **Sprint 7–13:** ЮKassa, GigaChat/YandexGPT/Ollama, Prometheus + Grafana, pgvector RAG, стриминг.
* **Sprint 14–16:** Декларативный Policy Engine & FQDN Egress (ADR 0004), seccomp, LangGraph Checkpointer в БД, HITL TTL, LLM Router v2, OTel + Sentry.
* **Sprint 17–20:** Вынос `llm-worker`, Redis/BullMQ, реальные Telegram, Google Workspace, Ozon/WB Finance, Midjourney (TTAPI), OCR/PDF/DOCX, Fact-Checker, Resume Screener.
* **Sprint 21–22:** Запуск 12 треков (`A–L`), MCP-серверы Битрикс24 и МойСклад, инструменты CRM/ERP (`bitrix24_*`, `moysklad_*`), UI подключения ключей.

---

## Этап 1: Post-Pilot Hardening & Design Partner Readiness (`v0.3.0-dp`)

**Цель этапа:** Безопасный онбординг первых 3–5 коммерческих Design Partners, устранение критического техдолга пилота, живая верификация всех 12 треков.

### Sprint 23: Access Control, Live ERP Verification & UX Polish (В РАБОТЕ)

* [x] **[INFRA-23.1]** Live smoke-тесты `--bitrix24` и `--moysklad` в `scripts/test-integrations.sh` + env `REGISTRATION_MODE` / `REGISTRATION_INVITE_CODE` + актуализация доки под 12 треков.
* [x] **[API-23.2]** Invite-only регистрация (`REGISTRATION_MODE=invite|closed`, `timingSafeEqual`), закрытие **KI-073**.
* [x] **[API-23.3]** Live-проверка вебхука Битрикс24 (`profile.json`) и токена МойСклад (`/entity/organization`) при сохранении (завершение **KI-075**).
* [x] **[API-23.4]** Поддержка нетарифицируемых позиций (`tracked: false`) и разбивки по складам (`stock_report`) в `moysklad_check_stock`, закрытие **KI-081**.
* [x] **[WORKER-23.5]** Условный HITL в `llm-worker` по значению аргумента (`stageId === 'WON'` для `bitrix24_update_deal`), закрытие **KI-079**.
* [x] **[UI-23.6]** Маскировка `Webhook URL` (`type="password"` + toggle) в настройках Битрикс24 (**KI-076**), поле `inviteCode` на форме регистрации и i18n ошибок.

### Sprint 24: Multi-Tenant MCP & Full K/L Track Capabilities

* [x] **[MCP-24.1]** Проброс per-user/per-tenant кредов из `ProviderCredential` в заголовки запросов к `ozon-mcp`, `wb-mcp`, `bitrix24-mcp`, `moysklad-mcp` (закрытие **KI-064**, **KI-077**).
* [x] **[MCP-24.2]** Расширение методов `moysklad-mcp` для треков K/L: создание отгрузки (`demand`), заказа поставщику (`purchaseorder`), проверка долга контрагента (`counterparty` balance) и техкарты/комплекты (`bundle`) (закрытие **KI-078**).
* [x] **[API-24.3]** Автоматический маппинг компании из сделки Битрикс24 в контрагента МойСклад при создании заказа (развитие **KI-080**).
* [ ] **[QA-24.4]** Контрактные E2E-тесты с mock/sandbox LLM для полного цикла `tool_calls -> HITL approve -> Ledger capture` (закрытие **KI-049**).
* [x] **[BILLING-24.5]** Перевод Pay-per-Call на двухфазную блокировку Hold -> Capture (по спецификации Billing-Flows.md) для защиты от параллельного перерасхода баланса.
* [x] **[WEB-24.6]** Интерактивный превью-симулятор 12 треков (A–L) без регистрации и форма заявки Design Partner (с уведомлением в Telegram) на лендинге skillwharf.ru.

---

## Этап 2: Enterprise Isolation & High Availability (`v0.4.0-enterprise`)

**Цель этапа:** Аппаратная изоляция кода для Enterprise-контуров (ADR 0002), отказоустойчивый кластер (ADR 0001) и соответствие требованиям ИБ.

### Sprint 25: Hardware Sandbox (Firecracker / gVisor)

* [ ] **[INFRA-25.1]** Драйвер `FirecrackerSandboxProvider` в `apps/sandbox-worker` для bare-metal/KVM-узлов (ADR 0002).
* [ ] **[INFRA-25.2]** Fallback-профиль `gVisor` (`runsc`) для облачных Kubernetes-кластеров без `/dev/kvm` + Helm/K8s манифесты (включая K8s Job для `db-migrate`, закрытие **KI-037**).
* [ ] **[SEC-25.3]** TLS egress-прокси с фильтрацией по SNI/Host и защитой от DNS rebinding (закрытие **KI-028**, **KI-042**).

### Sprint 26: Enterprise Auth, KMS & Observability Hardening

* [ ] **[SEC-26.1]** mTLS / подписанные JWT для внутреннего канала `api <-> llm-worker` вместо статического токена (закрытие **KI-045**).
* [ ] **[SEC-26.2]** Envelope-шифрование с `keyId`, ротация ключей и адаптер Yandex KMS / HashiCorp Vault (закрытие **KI-053**).
* [ ] **[INFRA-26.3]** SSO (OIDC) для Grafana/Prometheus (закрытие **KI-018**), durable trace storage (Tempo/Jaeger) для OTel Collector (закрытие **KI-038**).
* [ ] **[INFRA-26.4]** Шифрование и Object Lock для offsite-бэкапов S3 + изолированный стенд для `restore-drill` (закрытие **KI-035**, **KI-036**).

---

## Этап 3: Ecosystem, Marketplace & Scale (`v1.0.0-ga`)

**Цель этапа:** Открытая экосистема разработчиков навыков, монетизация через Revenue Share 85/15 и масштабирование RAG/векторного поиска.

### Sprint 27: Public Skill Registry & Security Signing

* [ ] **[API-27.1]** Криптографическая подпись манифестов `SKILL.md` (Ed25519) в дополнение к `checksum: sha256` и верификация при установке.
* [ ] **[API-27.2]** Публичный каталог навыков и сплитование платежей ЮKassa (Revenue Share 85% автору / 15% платформе, ADR 0002).
* [ ] **[WEB-27.3]** Витрина Marketplace в Web UI: поиск, фильтры по 12 трекам, рейтинги, установка в 1 клик.

### Sprint 28: Control Plane v2 & Qdrant Scale

* [ ] **[WEB-28.1]** UI и API для A/B-тестирования версий системных промптов на реальном трафике с метриками latency/cost/feedback (закрытие **KI-009**).
* [ ] **[API-28.2]** Динамические per-model тарифы LLM в Ledger и Prometheus вместо единого `LLM_COST_PER_1K_TOKENS` (закрытие **KI-040**).
* [ ] **[INFRA-28.3]** Векторный адаптер **Qdrant** как опциональный бэкенд долговременной памяти при росте базы эмбеддингов (ADR 0002) + метаданные чанков памяти (закрытие **KI-024**).

---

## Журнал выполнения и блокеров (заполняется агентами)

| Дата | Спринт / Задача | Агент | Статус | Коммит / Детали | Найденные проблемы (KI) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 2026-11-18 | Sprint 22 (22.1–22.3) | Infra / OpenCode / UI | Выполнено | Добавлены MCP-серверы Битрикс24/МойСклад, инструменты CRM/ERP и UI карточки | KI-075..KI-081 |
| 2026-11-18 | Sprint 23 (23.1–23.3) | Infra / OpenCode / UI | В работе | Промпты отправлены: инвайты, live-проверки ERP, KI-076/079/081 | — |
| 2026-11-18 | Sprint 24 (24.1–24.2) | Infra | Выполнено | Per-request креды в `bitrix24-mcp`/`moysklad-mcp`, новые методы K/L в `moysklad-mcp`, `MCP_ALLOW_MISSING_KEYS=1`; тесты MCP-серверов | KI-084 (Ozon/WB), KI-085 (OAuth/аудит) |
