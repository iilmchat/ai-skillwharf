# Changelog

Все значимые изменения в проекте документируются в этом файле.

## [Unreleased]

### Control Plane UI

- Защищённый раздел `/admin` с вкладками «Промпты», «LLM Роутер» и «Аудит». В «Промптах» доступны история версий и создание новой версии, в «LLM Роутере» — таблица правил и добавление правила, в «Аудите» — последние действия. Доступ разрешён только ролям `admin` и `owner`, ссылка в навигации показывается только им.

### Control Plane Backend

- Версионирование системных промптов в БД: модели `PromptTemplate` и `PromptVersion`, сидинг `default_system_prompt`, API `GET /api/v1/prompts`, `GET /api/v1/prompts/:id/versions`, `POST /api/v1/prompts/:id/versions` (роли `admin`/`owner`).
- `LlmService` читает активную версию промпта из БД без перезапуска API; при недоступности БД используется дефолтная инструкция.
- LLM Router: модель `LlmRoute`, выбор активного маршрута по `priority` перед вызовом LLM, fallback на `LLM_MODEL`/`LLM_BASE_URL` из окружения и CRUD `GET/POST/PATCH/DELETE /api/v1/admin/llm-routes` (роли `admin`/`owner`).
- Аудит Control Plane: модель `AuditLog`, запись при создании версии промпта и изменении LLM-маршрутов, эндпоинт `GET /api/v1/admin/audit` (роли `admin`/`owner`).
- Миграции `add_prompt_templates` и `add_llm_routes`.

### Marketplace

- Добавлены стартовые навыки `ozon-seller` и `wb-seller` с инструментами `ozon_mcp_call` и `wb_mcp_call`, разрешением `network` и бесплатной моделью.
- Реализованы MCP-заглушки для Ozon и Wildberries: инструменты принимают `action`/`params` и возвращают демонстрационные данные (продажи, заказы, товары, отзывы). Реальные MCP-серверы ещё не подключены.
- `ChatService` подключает marketplace-инструменты только при наличии соответствующего включённого навыка.

### Communication, Productivity & Creative

- Добавлены стартовые навыки `messenger-connector`, `google-workspace`, `midjourney-api` и `workflow-orchestrator`.
- Реализованы mock-инструменты `send_message`, `google_sheets_append`, `google_docs_create`, `generate_image` и `run_workflow`; реальные Telegram/VK/WhatsApp, Google Workspace и Midjourney API пока не подключены.
- `ChatService` подключает эти инструменты только при наличии соответствующего включённого навыка; `generate_image` использует Pay-per-Call цену из манифеста.

### Billing & Security

- Pay-per-Outcome (escrow): в `Wallet` добавлен `heldBalance`, в `LedgerEntry` — статус `PENDING`; реализованы `authorizeHold`, `captureHold` и `cancelHold`.
- Append-only защита Ledger сохранена: БД разрешает только перевод `PENDING` в `debit`/`credit`, остальные изменения и удаления по-прежнему запрещены.
- `ChatService` автоматически резервирует средства для инструментов с `pricing.model: Pay-per-Outcome`: успех → capture, ошибка → cancel, `requiresApproval` → hold остаётся `PENDING` до одобрения.
- Agent Gateway: `execute_sandbox_code` с `rm -rf /` блокируется `ForbiddenException`, а запросы `web_search` со словами `password`/`secret` маскируются до вызова инструмента.
- Манифесты поддерживают `pricing.model: Pay-per-Outcome`; миграция `add_escrow_support`.
- `GET /api/v1/billing/balance` возвращает `heldBalance` — сумму незавершённых `PENDING`-записей Ledger.
- Событие `office_event` со статусом `waiting_approval` содержит `reason`: `payment` для Pay-per-Outcome и `approval` для остальных инструментов.

### Content, HR & Legal

- Добавлены стартовые навыки `dzen-article`, `fact-checker`, `resume-screener` и `document-analyzer`.
- Реализованы mock-инструменты `check_facts`, `screen_resume` и `extract_document_data`; реальные API фактчекинга, HR-систем и юридических сервисов пока не подключены.
- `dzen-article` использует Pay-per-Outcome (100 ₽) и `requiresApproval: true`; `ChatService` подключает инструменты только при наличии соответствующего включённого навыка.
- `dzen-article` переведён с Mock на экспорт Markdown-черновика: инструмент `publish_to_dzen` пишет файл в `/tmp/dzen-output/` песочницы, переносит его в `./dzen-output` API и получает разрешение `filesystem`.

### Financial Analyst (Track J)

- Добавлены стартовые навыки `unit-economics`, `profit-leak-detector`, `price-monitor` и `fraud-shield-audit`.
- Реализованы mock-инструменты `calculate_unit_economics`, `detect_profit_leaks`, `monitor_competitor_prices` и `audit_fraud_risk`; реальные финансовые API и данные маркетплейсов пока не подключены.
- `profit-leak-detector` использует Pay-per-Call (300 ₽), `fraud-shield-audit` — Pay-per-Outcome (500 ₽) с обязательным одобрением; `price-monitor` запрашивает `network`.

## [0.1.0] - 2026-11-12

Первый публичный MVP: аутентификация, чат с агентом, песочница, биллинг,
каталог навыков и локализация.

### Добавлено

- Инициализация монорепозитория на pnpm workspaces, CI (сборка, тесты, Markdown-линтер, проверка песочницы) и базовая документация: C4-модель, спецификация Skill Manifest, схема биллинга, STRIDE Threat Model, Runbook развёртывания.
- Пакет `packages/shared` со схемами Zod (Skill Manifest, Billing).
- Каркас API на NestJS (`apps/api`), Docker-инфраструктура: `Dockerfile` для API и `docker-compose.yml` (API + PostgreSQL).
- Базовая песочница `docker-compose.sandbox.yml` (hardened Docker).
- Prisma ORM: модели `User`, `Session`, `Conversation`, `Message`, `Wallet`, `LedgerEntry`, `InstalledSkill`, `SkillUsage`, миграции и скрипт `db:migrate`.
- JWT-аутентификация: регистрация/логин (Argon2, access + refresh), ротация refresh-токенов, `JwtStrategy`, `JwtAuthGuard`, RBAC (`@Roles()`, `RolesGuard`) и профиль `GET /api/v1/auth/me`.
- WebSocket-чат: шлюз `send_message`, аутентификация по JWT из `handshake.auth.token`, проверка владельца диалога; REST `POST /api/v1/chat/conversations` и сохранение истории сообщений в БД.
- LangGraph (`StateGraph`) и LLM-клиент `@langchain/openai` с OpenAI-совместимым фасадом и эхо-заглушкой; локальный Ollama в `docker-compose` (профиль `with-llm`).
- Инструменты агента в LangGraph: `execute_sandbox_code`, `web_search` (Tavily), `exec`; цикл `tool_calls` с возвратом результата в LLM и лимитом раундов.
- Sandbox execution: изолированные Docker-контейнеры с лимитами CPU/памяти, таймаутом, read-only rootfs, allowlist секретов и egress по флагу; кастомный образ с `curl`, `jq`, `gh`, Python.
- Billing (Ledger): модели `Wallet` и append-only `LedgerEntry`, `DECIMAL(18,2)`, триггеры PostgreSQL против `UPDATE`/`DELETE`, идемпотентность по `idempotencyKey`, `balanceAfter` в каждой записи.
- Paywall: `BillingService.chargeForSkill` и атомарное списание; цены берутся из манифеста навыка; блокировка агента при балансе ниже `0.50`.
- Freemium: таблица `SkillUsage` и `BillingService.checkAndChargeSkill` — первые `freeCallsLimit` вызовов навыка бесплатны, дальше списывается `price`.
- BAL: интерфейс `IBillingProvider` (`authorize`/`capture`/`cancel`) и mock-провайдер ЮKassa.
- Каталог навыков: валидация и установка `SKILL.md`, `GET /api/v1/skills`, включение/отключение и удаление; авто-сидинг `starter-skills` при старте.
- Стартовый каталог навыков: `tavily-search`, `github`, `cron-automation`, `skill-vetter`, `code-runner`.
- История транзакций: `GET /api/v1/billing/ledger` (последние 50 операций) и пополнение баланса обычным пользователем.
- i18n: ключи ошибок API (`errors.insufficient_funds`) с переводом на клиенте, словари ru/en и переключатель языка в веб-интерфейсе; инструкция LLM отвечать на языке пользователя.
- Web UI (React 19 + Vite): авторизация, чат по WebSocket, управление навыками, баланс и пополнение, тёмная тема, локализация.

### Изменено

- CI настроен на проверку сборки, тестов, Markdown-линтера и тестов песочницы.
- Docker-образ API переведён на `pnpm deploy --prod` (560 МБ вместо 904 МБ), Prisma CLI для `db:migrate` ставится глобально.
- `POST /api/v1/billing/topup` доступен роли `user`; `userId` в теле стал опциональным и учитывается только для `admin`.
