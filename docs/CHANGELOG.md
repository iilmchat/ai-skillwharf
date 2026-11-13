# Changelog

Все значимые изменения в проекте документируются в этом файле.

## [Unreleased]

### Sprint 15: Pilot Reliability

**HITL & Checkpointer**
- Prisma-модели `GraphCheckpoint`, `GraphCheckpointWrite`, `PendingApproval`. Интеграция `PrismaCheckpointSaver` с LangGraph.
- HITL переведён на `interrupt()`/`Command({ resume })`: пауза хранится в БД, `approve_action` возобновляет граф после рестарта API.
- Escrow-hold создаётся до паузы с идемпотентным ключом; при resume hold переиспользуется.
- `GET /api/v1/chat/pending` для списка ожидающих одобрения; новое сообщение закрывает старое ожидание.

**LLM Budget Guard**
- Reserve-before-call: атомарное резервирование `prompt + max_tokens` до вызова (для всех путей).
- Reconcile после ответа (возврат/добавка), откат резерва при ошибке провайдера.
- Fallback-токенизатор (js-tiktoken) для GigaChat, если провайдер не прислал `usage`.
- Оценка токенов вынесена в `token-estimator.ts`.

**Infrastructure & Backups**
- Offsite-бэкапы в S3 через `rclone` (`upload-backup.sh`), retention.
- `restore-drill.sh` для проверки восстановления.
- One-shot `db-migrate` (init-container) вынесен из `entrypoint.sh` API. API ждёт его завершения (`service_completed_successfully`).
- `/api/v1/health/ready` и `/health/live` для k8s и Compose.

**Billing & Marketplace**
- Пагинация `GET /api/v1/billing/ledger` (keyset по `createdAt`, `id`), `nextCursor`.
- Месячный сброс Freemium-лимитов (`freemium-reset.service.ts`).

**Web UI**
- Проброс `VITE_RAG_MEMORY_ENABLED` через `docker-compose.yml` и staging.
- Маппинг MCP-ошибок (`errors.mcp_provider`, `mcp_timeout`, `mcp_unavailable`) на RU/EN с fallback.

**Новые известные проблемы:** KI-031 (ранний abort стрима), KI-032 (приблизительный prompt estimate), KI-033 (нет TTL ожиданий), KI-034 (нет retention checkpoint), KI-035–037 (hardening бэкапов и миграций).

### Infrastructure & Backups (Sprint 15)

- Offsite-бэкапы (KI-019): `scripts/backup-db.sh` после успешного локального `pg_dump` и локальной ротации вызывает `scripts/upload-backup.sh`, который через `rclone` выгружает дамп в S3-совместимое хранилище. Конфигурация — `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_PREFIX`, `BACKUP_S3_KEEP_DAYS`; без `BACKUP_S3_BUCKET` offsite выключен и локальный сценарий не меняется. При недоступном S3 локальный дамп сохраняется, ошибка понятна, код возврата `1`; retention offsite удаляет только `${POSTGRES_DB}-*.dump` старше `BACKUP_S3_KEEP_DAYS`.
- Restore-drill: `scripts/restore-drill.sh` скачивает последний offsite-дамп, создаёт временную БД `drill_*`, восстанавливает `pg_restore` и проверяет `User`/`LedgerEntry`; временная БД удаляется даже при ошибке, `0` возвращается только при успехе.
- Миграции (KI-007): добавлен one-shot Compose-сервис `db-migrate` (`prisma migrate deploy`, `restart: "no"`); `entrypoint.sh` API больше не запускает миграции, API ждёт `service_completed_successfully`, поэтому `--scale api=2` стартует без гонки. Добавлен Compose healthcheck API на `/api/v1/health/ready` и эндпоинты `/api/v1/health/live` (liveness) и `/api/v1/health/ready` (readiness).
- Runbook: включение offsite, проверка `restore-drill`, cron 02:00/03:00, откат, диагностика `db-migrate` и `unhealthy` API. Остаточные ограничения — KI-035..KI-037.

### Reliability & HITL (Sprint 15)

- LangGraph Checkpointer в PostgreSQL: новые таблицы `GraphCheckpoint`/`GraphCheckpointWrite` (Prisma-миграция `add_graph_checkpointer_and_pending_approval`), состояние графа сериализуется через `JsonPlusSerializer` в BYTEA и переживает рестарт API. Один диалог — один checkpoint-тред (`thread_id = conversationId`); инструменты в состояние не сериализуются, а пересобираются из снимка навыков в состоянии, поэтому checkpoint остаётся валидным после рестарта.
- HITL переведён с in-memory Promise на `interrupt()`/`Command({ resume })`: пауза `waiting_approval` хранится в checkpoint'е, а не в карте процесса. `approve_action` возобновляет граф (в том числе после рестарта API) и стримит ответ в текущий сокет; отклонение отменяет escrow-holds.
- Escrow Pay-per-Outcome: holds создаются до паузы с детерминированным `idempotencyKey` (`approval:<conversationId>:<callId>`) — повторное выполнение узла при resume переиспользует существующий `PENDING`-entry, второй hold не создаётся; capture/cancel остаются через append-only Ledger.
- Новая таблица `PendingApproval` (conversationId unique, tools/holds в JSON, status, resolvedAt) и `PendingApprovalService` с Zod-валидацией JSON-колонок. Эндпоинт `GET /api/v1/chat/pending` возвращает ожидающие подтверждения пользователя по Zod-контракту `{ items: [{ conversationId, reason, tools, createdAt }] }` (JWT, только свои диалоги).
- Checkpointer и persistence вынесены в `ChatPersistenceModule` с DI-токеном `GRAPH_CHECKPOINTER`; в тестах подменяется `MemorySaver`. Интеграционный тест эмулирует рестарт: pending approval создан → новый экземпляр `ChatService` → `approve_action` → capture escrow.

### LLM Budget Guard (Sprint 15)

- Дневной жёсткий лимит токенов стал reserve-before-call (KI-021): до вызова провайдера атомарно резервируется `prompt estimate + LLM_RESERVE_OUTPUT_TOKENS` (default 4096), при нехватке — `429 errors.daily_token_limit` до обращения к модели и до первой дельты стрима. После ответа выполняется reconcile (`refund`/добавка, при переполнении — clamp к лимиту и `gen_ai.budget.reconcile_overflow`), при ошибке провайдера резерв откатывается. Мягкий порог 80% логируется (`gen_ai.budget.soft_limit`). Конкурентный тест: из параллельных вызовов успешных ровно столько, сколько помещается.
- Fallback-токенизатор (KI-022): если провайдер (GigaChat) не прислал `usage`, prompt/completion оцениваются `js-tiktoken` (`cl100k_base`) с эвристическим fallback, оценка учитывается в дневном счётчике и биллинге; события `gen_ai.usage.fallback` и `gen_ai.usage_estimated`. GigaChat тарифицирует input/output одинаково, поэтому стоимость считается по суммарному объёму.
- Остаточные ограничения зафиксированы: KI-031 (abort стрима оставляет резерв не сверенным), KI-032 (приближение оценки prompt-токенов).

### Billing & Marketplace (Sprint 15)

- Пагинация `GET /api/v1/billing/ledger`: Zod-контракт `{ items, total, nextCursor }`, query `limit`/`offset`/`cursor` (opaque base64url `{createdAt,id}`, strict, курсор+offset → 400 `errors.invalid_request`), keyset-пагинация `(createdAt, id)` без дублей, `total` — все операции пользователя. Web-потребитель `apps/web/src/lib/billing.ts` валидирует новый контракт Zod-схемой, модалка истории показывает `items`.
- Периодический сброс Freemium-лимитов: `FreemiumResetService` (таймер, env `FREEMIUM_RESET_INTERVAL_MS`, default 24 ч) обнуляет `SkillUsage.callsCount` записей с `lastResetAt` из прошлых месяцев (UTC); операция идемпотентна и безопасна для 2+ реплик API.

### Security & Sandbox (Sprint 14)

- Кастомный seccomp-профиль `sandbox/seccomp-profile.json` (default-deny, `SCMP_ACT_ERRNO`): allowlist для Node/V8, Python, bash/curl/jq/gh; явный запрет `ptrace`, `mount`, `unshare`, `setns`, `bpf`, `keyctl`, `perf_event_open`, `kexec_*`, `reboot`, `swapon/off`, `init_module`, `pivot_root`, `chroot`, `personality`, `userfaultfd`, `process_vm_*`. `clone` разрешён только без namespace-флагов, `clone3` → `ENOSYS`. `sandbox-worker` читает `SANDBOX_SECCOMP_PROFILE`, валидирует Zod, передаёт inline JSON в Docker `SecurityOpt`. Fail closed при невалидном профиле. Staging — обязателен. Закрывает KI-005.
- Декларативный policy engine вместо regex: `apps/api/src/security/policy/` — strict Zod-схемы аргументов для 18 инструментов, структурный shell-анализатор (кавычки, `${IFS}`, ANSI-C, `; && || |`, `eval`, вложенный shell, `child_process`, `/proc/*/environ`), secret-taint (GitHub/OpenAI/AWS/JWT/Bearer/PEM), deny-by-default для неизвестных инструментов, роли, taint из `web_search`/MCP блокируется в `exec`/песочнице/MCP/каналах и маскируется в поиске. Блокировки — 403 `errors.policy_blocked`, аудит в append-only Ledger. Закрывает KI-013.
- FQDN-aware egress: `egress_allowlist` из манифеста → egress-gateway; навык без allowlist не имеет сети даже при `SANDBOX_ALLOW_NETWORK=true`. `sandbox-worker` поднимает `NET_ADMIN`, root-entrypoint настраивает iptables (ACCEPT tcp 80/443 только на IP разрешённых FQDN, DROP по умолчанию), далее `su-exec 65534`. `SANDBOX_ALLOW_NETWORK`/`ALLOW_NETWORK` больше не включают сеть. Закрывает KI-008.

### MCP Gateway & LLM (Sprint 14)

- MCP Gateway: strict-валидация `action`/`params` до `client.callTool`, per-action strict-схемы для известных ozon/wb-действий, единые ошибки 400/502/503/504, таймауты 15 с/попытка, retry 1×250 мс только для transient transport/5xx. `mcp_endpoint` из манифеста — источник адреса (env — fallback). Закрывает ADR 0004 п.1–2.

### RAG Memory API (Sprint 14)

- `GET /api/v1/chat/memory`: `{ items: [{ id, content, createdAt }], total }`, Zod-валидация query/response, сортировка `createdAt desc`, `limit`/`offset` с 400 `errors.invalid_request`, только записи JWT-пользователя. Закрывает KI-023 (backend).
- Web UI: панель «Память» за флагом `VITE_RAG_MEMORY_ENABLED` (default false) делает реальный запрос к `GET /api/v1/chat/memory`, Zod-валидация, состояния загрузки/пусто/ошибки/retry, `apps/web/Dockerfile` принимает build-arg `VITE_RAG_MEMORY_ENABLED`. Закрывает KI-023 (UI).

### Web UI (Sprint 14)

- Ошибки распознаются по машиночитаемому `code` (`errors.daily_token_limit`, `errors.insufficient_funds`, `errors.mcp_provider`, `errors.mcp_timeout`, `errors.mcp_unavailable`) с полным fallback на текстовые маркеры старого API. Логика вынесена в `apps/web/src/lib/chat-errors.ts`, покрыта тестами.
- MCP-ошибки (`errors.mcp_provider`, `errors.mcp_timeout`, `errors.mcp_unavailable`) показываются пользователю понятным сообщением на RU/EN через i18n (`chat.errors.mcp*`): «MCP-провайдер вернул ошибку / не ответил вовремя / недоступен. Попробуйте позже»; коды имеют приоритет над текстом, fallback на текстовые маркеры сохранён (KI-025 уточнён).
- `docker-compose.yml` и `docker-compose.staging.yml` пробрасывают `VITE_RAG_MEMORY_ENABLED` в `build.args` сервиса `web` (`${VITE_RAG_MEMORY_ENABLED:-false}`), `.env.example` документирует переменную. Docker-сборка с флагом включает панель «Память», без флага — нет (KI-030 закрыт).
- Новые KI: KI-025 (не все ошибки API имеют `code`), KI-026 (seccomp профиль — только amd64), KI-027 (MCP structural-only actions), KI-028 (egress IP-pinning/DNS-tunneling/ip6tables), KI-029 (shell-анализатор — эвристика, не полный POSIX-парсер), KI-030 (VITE_RAG_MEMORY_ENABLED не проброшен в compose).

### MCP Gateway

- Отдельный слой проверки MCP-вызовов (`apps/api/src/llm/tools/mcp-gateway.ts`): аргументы `ozon_mcp_call`/`wb_mcp_call` валидируются Zod-схемой до отправки на MCP-сервер — `action` по шаблону, `params` только плоские примитивы (≤50 ключей, строки ≤4096, без вложенных объектов), для известных действий ozon/wb действуют strict-схемы. Невалидный вызов → 400 `errors.invalid_request`, клиент MCP не вызывается.
- `mcp_endpoint` из манифеста навыка стал источником истины для подключения MCP-сервера (env `OZON_MCP_URL`/`WB_MCP_URL` — только fallback для совместимости); адреса в коде не хардкодятся.
- Ошибки MCP-провайдера маппятся в единый JSON: 502 `errors.mcp_provider`, таймаут 504 `errors.mcp_timeout`, не сконфигурированный сервер 503 `errors.mcp_unavailable`. Таймауты осознанные: 15 с на попытку, один retry (250 мс) только для временных транспортных ошибок/5xx; JSON-RPC-ошибки провайдера и таймауты не повторяются.
- `McpClient` получил типизированные ошибки (`McpTransportError`, `McpProviderError`, `McpTimeoutError`), маскирование секретов в сообщениях и корректное закрытие SSE-сессии при неудачной инициализации.

### RAG Memory API

- `GET /api/v1/chat/memory` (KI-023): read-API памяти отдаёт `{ items: [{ id, content, createdAt }], total }` с сортировкой по `createdAt desc`; пагинация `limit`/`offset` валидируется Zod (400 `errors.invalid_request` для невалидного query), ответ проверяется Zod-схемой. Права: только записи текущего пользователя из JWT, `userId` из query не принимается, без аутентификации — 401. Запись, поиск и удаление памяти не изменялись.
- UI-панель памяти (`apps/web`) уже валидировала контракт и теперь получает реальные данные; включение флага в Docker-сборке вынесено в KI-030.

### Infrastructure & Security

- Grafana и Prometheus в staging закрыты HTTP Basic Auth. Caddy защищает `/grafana/` и `/prometheus/`, Prometheus дополнительно использует нативный `web.config.file` с `basic_auth_users` и bcrypt-хэшем; без кредов оба пути отдают `401`.
- Пароли и хэши мониторинга не хранятся в git: добавлены `MONITORING_BASIC_AUTH_USER`, `MONITORING_BASIC_AUTH_PASSWORD`, `MONITORING_BASIC_AUTH_HASH`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`. Дефолтный `admin/admin` больше не используется, пустые значения останавливают запуск контейнеров.
- Grafana провижинит datasource Prometheus с Basic Auth, поэтому дашборды работают при закрытом `/metrics`; API healthcheck и `/api/v1/health` не затронуты.
- Добавлена ротация бэкапов БД `scripts/rotate-backups.sh`: `BACKUP_KEEP_DAYS` дней, но не меньше `BACKUP_KEEP_MIN` последних дампов, удаление только просроченных файлов, лог каждого удаления и режим `--dry-run`/`-DryRun`.
- `scripts/backup-db.sh` проверяет свободное место (`BACKUP_MIN_FREE_MB`), пишет дамп во временный `.partial`, проверяет непустоту и запускает ротацию только после успешного `pg_dump`.
- Runbook обновлён: включение бэкапов и ротации, проверка, восстановление, изменение retention, генерация bcrypt-хэша и проверка `401`/`200` для мониторинга.
- Добавлен кастомный default-deny seccomp-профиль `sandbox/seccomp-profile.json` (allowlist для Node.js/V8, Python, curl, jq, gh и bash). Опасные сисколлы (`ptrace`, `mount`, `unshare`, `setns`, `bpf`, `keyctl`, `perf_event_open`, `kexec_*`, `reboot`, `swapon/swapoff`, `init_module`, `delete_module`, `pivot_root`, `chroot`, `personality`, `userfaultfd` и др.) запрещены явно, `clone` ограничен маской namespace-флагов; KI-005 закрыт.
- `sandbox-worker` применяет профиль через `SANDBOX_SECCOMP_PROFILE`: файл читается внутри worker, валидируется Zod и передаётся Docker API как inline `seccomp=<json>` в `HostConfig.SecurityOpt`. Пустая переменная сохраняет профиль Docker по умолчанию, в staging профиль обязателен; ошибка чтения/валидации останавливает worker (fail closed).
- `scripts/test-sandbox.sh` проверяет bash/curl/jq/gh/Python и Node.js/V8 с worker_threads под профилем, а также `EPERM` для ptrace, mount, unshare, keyctl, perf_event_open, personality, bpf и userfaultfd. Runbook дополнен включением, проверкой и откатом профиля.

### Web UI

- Ошибки чата распознаются по машиночитаемому `code` из `WsException` и JSON-тела ошибки API: `errors.daily_token_limit` и `errors.insufficient_funds` больше не зависят от текста сообщения. HTTP 429 и текстовые маркеры (`Too Many Requests`, `Недостаточно средств`) сохранены как fallback для старого API без `code` (KI-025). Логика вынесена в `apps/web/src/lib/chat-errors.ts` и покрыта тестами: ошибка с `code` распознаётся при произвольном тексте, без `code` — по статусу и тексту.
- Zod-схема RAG-панели закреплена за контрактом Sprint 14 `{ items: [{ id, content, createdAt }], total? }`: при расхождении API панель показывает ошибку валидации и не подменяет данные. `fetchMemoryEntries` запрашивает `GET /api/v1/chat/memory`; тесты проверяют запрос, невалидный ответ, отрицательный `total` и отбрасывание лишних полей.
- `apps/web/Dockerfile` принимает build-arg `VITE_RAG_MEMORY_ENABLED` (по умолчанию `false`), поэтому раздел «Память» можно включить и в Docker-сборке; проброс аргумента через `docker-compose.yml`/`staging` добавлен в этом изменении (KI-030).
- Страница настроек дополнена разделом «Память»: feature-flag `VITE_RAG_MEMORY_ENABLED` (по умолчанию выключен) управляет показом списка записей RAG-памяти. После появления `GET /api/v1/chat/memory` (см. раздел «RAG Memory API») раздел работает с реальными данными, вымышленные записи не подставляются (KI-023).
- Ответ памяти валидируется Zod (`id`, `content`, `createdAt`); панель показывает краткое содержание, тип «фрагмент памяти» и дату создания через `<time>`, поддерживает состояния загрузки, пустоты, ошибки (401/404/сеть/невалидный ответ) и повторную загрузку.
- Полировка страницы настроек: единый контейнер и отступы секций, `aria-labelledby`/`aria-describedby`, `aria-busy`/`aria-live`, focus-visible у новых кнопок, адаптивная вёрстка; строки добавлены в RU/EN-словари.
- `apps/web/README.md` дополнен разделом о настройках, памяти и переменной `VITE_RAG_MEMORY_ENABLED`.

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
- ЮKassa: реальный провайдер `YooKassaProvider` (REST `POST /v3/payments`, Basic Auth, `Idempotence-Key`), `POST /api/v1/billing/create-payment` возвращает ссылку на оплату, публичный `POST /api/v1/billing/webhook` зачисляет средства по `payment.succeeded` с идемпотентностью по `paymentId`.
- `BillingModule` подключает `YooKassaProvider`, если заданы `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY`, иначе остаётся mock; добавлена переменная `YOOKASSA_RETURN_URL`.
- Прямое пополнение `POST /api/v1/billing/topup` оставлено только роли `admin` для dev-сценариев; обычные пользователи пополняют баланс через ЮKassa (`POST /api/v1/billing/create-payment`).
- Cost Guardrails для LLM: `LlmService` списывает `0.01 ₽` за каждую 1000 токенов (`prompt_tokens + completion_tokens`) с описанием «Использование LLM» и отклоняет вызов до обращения к модели, если баланс меньше копейки.
- Добавлена спецификация [Cost Guardrails](billing/Cost-Guardrails-Specification.md): тарификация токенов, минимальный баланс для запуска агента и ограничение ручного `topup` ролью `admin`.
- Реальные адаптеры российских LLM: `YandexAdapter` (URI `gpt://<folder>/<model>`, Bearer IAM-токен) и `GigaChatAdapter` (OAuth с кэшем токена на 30 минут, один `tool_call` за ход); `LlmService` выбирает адаптер по `providerType` маршрута, OpenAI-совместимые провайдеры работают как раньше.

### LLM: Budget Guards и стриминг GigaChat

- Дневной жёсткий лимит токенов стал атомарным: после ответа модели токены списываются через `User.updateMany` с условием `dailyTokensUsed + tokens <= dailyTokenLimit`. При конкурентных запросах счётчик больше не может превысить лимит (`count === 0` → отказ), тест на `Promise.all` из 10 одновременных вызовов подтверждает ровно `floor(limit / tokens)` успешных.
- Мягкий порог (80% от жёсткого лимита) сохраняется как предупреждение в логе (`gen_ai.budget.soft_limit`), а превышение жёсткого лимита возвращает `429` в едином JSON-формате `{ statusCode, error, code, message }` (`code: errors.daily_token_limit`), который понимает клиент.
- `GigaChatAdapter` поддерживает стриминг (`stream: true`, SSE): дельты текста идут в существующий транспорт (`stream_delta` → WebSocket), финальное сообщение содержит `usage` и `tool_calls`. Чанки и ошибки провайдера валидируются Zod-схемами, есть таймаут простоя стрима и fallback на нестриминговый запрос, если стрим упал до первой дельты; OpenAI-совместимые провайдеры и YandexGPT работают как раньше.

### Content, HR & Legal

- Добавлены стартовые навыки `dzen-article`, `fact-checker`, `resume-screener` и `document-analyzer`.
- Реализованы mock-инструменты `check_facts`, `screen_resume` и `extract_document_data`; реальные API фактчекинга, HR-систем и юридических сервисов пока не подключены.
- `dzen-article` использует Pay-per-Outcome (100 ₽) и `requiresApproval: true`; `ChatService` подключает инструменты только при наличии соответствующего включённого навыка.
- `dzen-article` переведён с Mock на экспорт Markdown-черновика: инструмент `publish_to_dzen` принимает `title`, `text` и необязательный `imageUrl`, пишет файл в `/tmp/dzen-output/` песочницы, переносит его в `./dzen-output` API и получает разрешение `filesystem`.

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
