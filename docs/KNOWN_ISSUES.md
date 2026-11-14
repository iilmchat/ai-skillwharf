# Known Issues (Известные проблемы)

**Правило:** Каждая проблема имеет ID, влияние, обход и план.

| ID | Область | Серьёзность | Статус | Кратко |
| --- | --- | --- | --- | --- |
| KI-001 | Инфраструктура | Средняя | Закрыто | Образ API весил 904 МБ; после оптимизации 367 МБ (`pnpm deploy --prod`), новый рост — см. KI-006 |
| KI-002 | Инфраструктура | Высокая | Исправлено | Dockerfile не копирует `packages/shared` (сборка упадет при импорте) |
| KI-003 | CI/CD | Низкая | Закрыто | CI не собирал Docker-образ (добавлен шаг `docker compose build api`) |
| KI-004 | Backend | Высокая | Исправлено | Нет эндпоинтов `/health` и скрипта `db:migrate` (упомянуты в Runbook) |
| KI-005 | Sandbox | Низкая | Исправлено | Кастомный default-deny seccomp-профиль применяется worker при `SANDBOX_SECCOMP_PROFILE`; в staging обязателен |
| KI-006 | Инфраструктура | Средняя | Исправлено | LangChain/LangGraph вынесены в `apps/llm-worker`; API собирается без `@langchain/*`, размер образа — см. детали |
| KI-007 | Инфраструктура | Высокая | Исправлено | Миграции вынесены в one-shot `db-migrate`; API-реплики ждут его успешного завершения |
| KI-008 | Sandbox | Высокая | Исправлено | Egress по манифесту: `egress_allowlist` → iptables-allowlist в sandbox-контейнере, без списка сеть запрещена (deny by default) |
| KI-009 | Frontend | Низкая | Открыто | Интерфейс A/B-тестирования промптов пока не реализован |
| KI-010 | LLM Router | Средняя | Исправлено | `LlmRouter` v2: fallback-цепочки по `priority`/`taskType`, budget guardrails на маршрут через Ledger, 502 при исчерпании всех маршрутов |
| KI-011 | Marketplace | Средняя | Открыто | MCP-серверы `ozon_mcp` и `wb_mcp` работают в режиме заглушки и возвращают демонстрационные данные |
| KI-012 | Marketplace | Средняя | Исправлено | Telegram (Bot API, webhook) и Google Workspace (OAuth, Sheets/Docs/Calendar) работают реально; оставшиеся внешние API (Midjourney, Ozon, WB) — отдельные задачи Sprint 19+ |
| KI-013 | Security | Средняя | Исправлено | `AgentGateway` заменён декларативным policy engine: Zod-схемы, allowlist команд, taint tracking, роли/контекст, аудит блокировок |
| KI-014 | Content/HR/Legal | Средняя | Исправлено | `fact-checker` ищет через Tavily и сравнивает источники, `resume-screener` разбирает резюме, `document-analyzer` извлекает реквизиты, `pdf-extractor`/`docx-writer`/`ocr-smart-engine` работают на реальных данных; Mock-ответов нет |
| KI-015 | Finance | Средняя | Исправлено | Финансовые навыки считают по реальным данным Ozon/WB через MCP (аналитика, начисления, отчёт о реализации, удержания, цены); без данных — `dataAvailable:false` или ошибка провайдера |
| KI-016 | Инфраструктура | Высокая | Исправлено | В staging Grafana использовала `admin/admin`, а Prometheus был без авторизации |
| KI-017 | Инфраструктура | Средняя | Исправлено | Бэкапы БД накапливались без retention-политики и проверки свободного места |
| KI-018 | Инфраструктура | Средняя | Открыто | Мониторинг использует общие статические Basic Auth-креды; нет SSO, per-user аудита и автоматической ротации |
| KI-019 | Инфраструктура | Средняя | Исправлено | Offsite-копии в S3 через rclone, retention `BACKUP_S3_KEEP_DAYS` и restore-drill во временную БД |
| KI-020 | Finance | Высокая | Исправлено | Дневной жёсткий лимит токенов можно превысить конкурентными запросами (read-check-write без атомарности) |
| KI-021 | LLM | Средняя | Исправлено | Дневной лимит токенов резервируется до вызова LLM (reserve-before-call) с reconcile после ответа и откатом при ошибке; лимит не превышается при гонке |
| KI-022 | LLM | Средняя | Исправлено | При отсутствии `usage` (GigaChat) расход оценивается fallback-токенизатором и учитывается в счётчике и биллинге |
| KI-023 | Frontend/Backend | Высокая | Исправлено | Read-API `GET /api/v1/chat/memory` с Zod-контрактом, права владельца и пагинацией; UI-панель памяти готова и включается флагом |
| KI-024 | Frontend/Backend | Низкая | Открыто | `MemoryChunk` не хранит тип, источник, `updatedAt` и confidence; UI показывает только текст и дату создания |
| KI-025 | Frontend/Backend | Низкая | Исправлено | Все коды ошибок API (`invalid_request`, `policy_blocked`, MCP, лимиты) маппятся в UI по `code` с i18n RU/EN; текстовый fallback сохранён |
| KI-026 | Sandbox | Низкая | Открыто | Seccomp-профиль рассчитан на linux/amd64 и проверяется smoke-тестом вне worker; смена профиля требует перезапуска worker |
| KI-027 | Security | Средняя | Исправлено | MCP Gateway использует `tools/list` для dynamic discovery и отклоняет неизвестные actions до вызова; при недоступности — structural-only с логом |
| KI-028 | Sandbox | Средняя | Исправлено | Egress: DNS только для root-entrypoint, strict ip6tables, ExtraHosts для read-only rootfs; остаточные SNI/SSRF — KI-042 |
| KI-029 | Security | Средняя | Открыто | Структурный анализатор shell — эвристика, а не полный POSIX-парсер; интерпретаторы (`python3`, `node`) могут строить команды/сеть внутри процесса, allowlist команд — defense-in-depth |
| KI-030 | Frontend/Build | Низкая | Исправлено | `VITE_RAG_MEMORY_ENABLED` проброшен в build-args `docker-compose.yml` и `docker-compose.staging.yml`; `.env.example` документирует переменную |
| KI-031 | LLM | Низкая | Открыто | Ранний abort клиентского стрима (или падение native-стрима без usage) оставляет резерв токенов не сверенным: счётчик завышен до суточного сброса, жёсткий лимит не превышается |
| KI-032 | LLM | Низкая | Открыто | Оценка prompt-токенов приблизительная (`cl100k_base`, схемы tools не учитываются); при `actual > reserved` счётчик клампится к лимиту — возможен дрейф учёта |
| KI-033 | Finance/Chat | Средняя | Исправлено | HITL TTL: `expiresAt`, фоновый job отменяет просроченные ожидания, hold возвращается, checkpoint удаляется, `GET /chat/pending` отдаёт `expiresAt` |
| KI-034 | Persistence | Низкая | Исправлено | Retention-job удаляет checkpoint'ы завершённых/осиротевших тредов (после `CHECKPOINT_RETENTION_DAYS`), не трогая активные и ожидающие |
| KI-035 | Инфраструктура | Низкая | Открыто | Offsite-бэкапы зависят от rclone на хосте; нет object-lock/versioning, KMS-шифрования и проверки checksum на уровне скрипта |
| KI-036 | Инфраструктура | Низкая | Открыто | Restore-drill выполняется на том же PostgreSQL и проверяет только наличие таблиц; алерты ограничены кодом возврата и логами cron |
| KI-037 | Инфраструктура | Низкая | Открыто | `db-migrate` — Compose one-shot; в Kubernetes нужен Job, а при одновременном запуске нескольких `compose up` защита опирается на advisory locks Prisma |
| KI-038 | Observability | Низкая | Открыто | OTel Collector хранит трейсы только в stdout (debug), без durable backend, sampling, retention, auth/TLS; спаны usage фиксируют итог вызова, а не полную latency |
| KI-039 | Observability | Низкая | Открыто | Sentry включён только для backend-ошибок и только при DSN; PII-фильтр — эвристика по regex, frontend Sentry и алертинг не подключены |
| KI-040 | Observability | Низкая | Открыто | `llm_cost_total` считает стоимость по единому `LLM_COST_PER_1K_TOKENS`, без per-model тарифов/скидок; `tenant_id` — unbounded user id, возможна кардинальность Prometheus |
| KI-041 | LLM Router | Низкая | Исправлено | Control Plane UI не показывал и не редактировал `taskType`/`dailyCostLimit`; поля добавлены в форму создания и редактирования, лимит выведен в таблице, ответ API валидируется Zod |
| KI-042 | Sandbox | Средняя | Открыто | Egress: нет SNI/Host-фильтрации (allowlist — IP:port, разрешённый IP можно использовать с любым Host), DNS rebinding/SSRF через разрешённый FQDN, ротация IP/CDN и рассинхрон worker/entrypoint, ExtraHosts только IPv4 |
| KI-043 | Persistence/MCP | Низкая | Открыто | Resolved-записи `PendingApproval` не чистятся retention-job; MCP `tools/list` кешируется на время SSE-сессии, изменения набора действий подхватываются после переподключения |
| KI-044 | LLM Router | Низкая | Исправлено | 502 `errors.llm_unavailable` отдаётся и для одиночного маршрута/env-fallback: retriable-ошибка провайдера больше не утекает сырым текстом |
| KI-045 | Security | Средняя | Открыто | Внутренние эндпоинты API и llm-worker защищены общим `INTERNAL_API_TOKEN`; при пустом значении доступ открыт (dev), нет mTLS/подписей и network policy |
| KI-046 | LLM Worker | Низкая | Открыто | JSON Schema инструментов конвертируется в Zod подмножеством; незнакомые конструкции (сложные union, `$ref`) становятся `z.unknown()` |
| KI-047 | Notifications | Низкая | Открыто | BullMQ-уведомление об ожидающем подтверждении только пишется структурным логом: нет email/push/webhook и подтверждения доставки |
| KI-048 | LLM Worker | Средняя | Открыто | Worker синхронно ходит в API на каждый LLM-вызов (бюджет), tool-call, HITL и checkpoint; нет circuit breaker/retry и деградации при недоступности API |
| KI-049 | E2E | Низкая | Открыто | E2E проверяет чат в echo-режиме (без LLM и tool-calls); путь worker → API tools/approvals/HITL покрыт только unit-тестами |
| KI-050 | Integrations | Низкая | Исправлено | Контракт UI реализован бэкендом (`GET /integrations`, `POST/DELETE /integrations/telegram`, `authorization-url`, `DELETE /integrations/google`); OAuth-callback умеет redirect (`GOOGLE_OAUTH_SUCCESS_REDIRECT`), иначе JSON; реальные ключи проверяются в staging |
| KI-051 | Security | Средняя | Открыто | Telegram webhook защищён только секретом и rate limit на IP: нет allowlist сетей Telegram, проверки `update_id` на replay/idempotency и очереди дедупликации |
| KI-052 | Security | Средняя | Открыто | Egress api/worker — прикладной allowlist (`provider-http`, LLM-маршруты), а не NetworkPolicy/iptables; embeddings, MCP и YooKassa API не все проходят через единый guard |
| KI-053 | Security | Средняя | Открыто | OAuth-токены шифруются локальным AES-256-GCM ключом из env; нет облачного KMS, keyId в envelope/БД и ротации без потери доступа |
| KI-054 | Security | Низкая | Открыто | `DELETE /integrations/google` удаляет локальные токены, но не вызывает revoke в Google; refresh-token может оставаться действительным |
| KI-055 | Marketplace | Средняя | Исправлено | `generate_image` реально вызывает Midjourney API (async polling, retry); финансовые данные Ozon/WB идут через MCP — демонстрационных значений в этих инструментах нет |
| KI-056 | Integrations | Низкая | Открыто | Telegram: webhook обслуживает один системный бот; боты, подключённые пользователями, используются только для исходящих `sendMessage`, входящие для них не принимаются |
| KI-057 | Marketplace | Низкая | Открыто | MCP-healthcheck проверяет наличие env-ключей Ozon/WB и `/api/health`, но не scope/срок действия и не реальный доступ к Seller API; ключи, заданные через web-панель, не учитываются |
| KI-058 | E2E | Низкая | Открыто | `scripts/test-integrations.sh` использует версионно-зависимые endpoint'ы Ozon (`/v1/product/import/prices`), WB Pricing (`/ping`) и TTAPI (`/midjourney/v1/fetch`); при смене API возможны ложные FAIL, путь настраивается через env |
| KI-059 | Marketplace | Средняя | Открыто | Midjourney подключается только через TTAPI (`api.ttapi.io`): официального API нет, GoAPI/UseAPI закрыты, SLA/контракт прокси не гарантированы; альтернативный APIFRAME требует отдельного allowlist |
| KI-060 | Finance | Низкая | Исправлено | Финансовый дашборд получил REST-контракт: `GET /finance/overview` и fallback `/finance/unit-economics`, `/finance/profit-leaks`, `/finance/fraud-shield` отдают последние результаты реальных MCP-вызовов, совместимы с Zod-схемой UI и возвращают `dataAvailable:false`, если расчётов ещё не было |
| KI-063 | Integrations | Средняя | Исправлено | Ключи Ozon/WB/Midjourney сохраняются per-user в `ProviderCredential` (AES-256-GCM), маршруты `POST/DELETE /integrations/{ozon,wildberries,midjourney}` и статусы в `GET /integrations` реализованы; инструменты берут ключи из БД с fallback на env |
| KI-061 | Finance | Низкая | Открыто | Ozon не привязывает комиссию/логистику к SKU в начислениях: `unit-economics` распределяет расходы по доле выручки SKU и не заменяет детализацию отчёта Ozon |
| KI-062 | Finance | Средняя | Открыто | MCP-серверы Ozon/WB не отдают ERID/UTM отдельными полями: `fraud-shield-audit` проверяет их наличие в сырых данных кампании и сообщает об отсутствии, но не заменяет юридическую проверку маркировки |
| KI-064 | Integrations | Средняя | Открыто | Личные ключи Ozon/WB сохраняются и видны в UI, но MCP-контейнеры аутентифицируются своими env-ключами (один набор на сервер), поэтому мульти-тенантные запросы идут под ключами контейнера |
| KI-065 | Frontend/Backend | Средняя | Исправлено | `POST /api/v1/documents` реализован: multipart-поле `file`, лимит 15 МБ, PDF/PNG/JPEG/WebP, ответ `{id, filename, mimeType, size, kind, text, tables, warnings, createdAt}`, ошибки 413/415 в едином JSON |
| KI-066 | Frontend/Backend | Низкая | Открыто | Разметка результата агента (pipe-таблицы, ```` ```json ```` с резюме) — договорённость UI: если агент вернёт другую структуру, чат покажет её текстом/кодом; E2E на реальные tool-calls (KI-049) это не покрывает |
| KI-067 | HITL | Низкая | Открыто | В `office_event` нет списка инструментов ожидания: карточка HITL узнаёт, что подтверждается публикация `dzen-article`, только из `GET /chat/pending`; при недоступном REST кнопка подписана нейтрально |
| KI-068 | Documents/OCR | Средняя | Открыто | Контракт Smart Document Engine не подтверждён вендором: адаптер терпим к формам ответа, Tesseract-fallback ограничен лимитами песочницы (10 с, 128 МБ) и не подходит для больших сканов |
| KI-069 | Documents | Низкая | Открыто | Собственный PDF-парсер не поддерживает шифрование, фильтры кроме FlateDecode и CID без ToUnicode; `write_docx` не делает `numbering.xml`, объединённые ячейки и стили; основная сумма/дата — эвристика |
| KI-070 | Documents | Низкая | Открыто | `POST /documents` не сохраняет файл (memory storage, 15 МБ), нет антивируса, квот и повторной выдачи по `id`; `pdftotext`/`pandoc` в образе пока не используются API |
| KI-071 | Documents/OCR | Средняя | Открыто | Адаптер OCR не передаёт `x-folder-id` и `languageCodes` Yandex Vision: запрос `{content,mimeType,language}` и `Authorization: Bearer` подходят для SDE-совместимого API, но облачный Yandex Vision требует `x-folder-id` и `languageCodes`, поэтому без доработки адаптера или прокси облачный путь вернёт 400/403 |
| KI-072 | Sandbox | Низкая | Открыто | Образ `skillwharf-sandbox` вырос до ~624 МБ: `pandoc` (~220 МБ) и языковые данные `tesseract` (~42 МБ) увеличивают время сборки в CI и первую загрузку на узел; альтернатива — отдельный образ `skillwharf-documents` |
| KI-073 | Security | Низкая | Открыто | `POST /api/v1/auth/register` доступен без инвайтов (защищён только rate-limit 10/час). Для пилота приемлемо, для Enterprise нужен инвайт-код. |
| KI-074 | API | Низкая | Открыто | Нет REST-эндпоинта для отправки сообщений в чат (только Socket.IO). Swagger/Postman не могут протестировать чат напрямую. |

## Детали

### KI-001 — Образ API весил 904 МБ

**Влияние:** Долгая передача по сети, лишнее место на диске.
**План:** Использовать `corepack` вместо глобального npm, `node:24-alpine` → `distroless`, `pnpm deploy --prod`.
**Исправлено:** `pnpm deploy --prod` в builder'е и отдельная рантайм-стадия: копируются только production-`node_modules`, `dist` и `prisma` (схема + клиент). В рантайме нет npm/yarn/corepack, остаётся только Prisma CLI для `migrate deploy`. Размер — 367 МБ вместо 904 МБ, контейнер работает под непривилегированным `appuser` (UID 1001).

### KI-002 — Dockerfile не копирует packages/shared

**Влияние:** Как только в коде API появится `import { ... } from '@skillwharf/shared'`, сборка контейнера упадет.
**План:** Обновить Dockerfile, добавив копирование `packages/shared/package.json` и исходников.
**Исправлено:** Dockerfile копирует манифест и исходники `packages/shared` на обоих stage'ах.

### KI-003 — CI не собирает Docker-образ

**Влияние:** Регрессии в `Dockerfile` (забытые файлы, сломанные стадии) ловятся только при деплое.
**План:** Добавить в job `build-and-test` шаг `docker compose build api`.
**Исправлено:** Шаг `Test Docker Build` собирает образ API в CI без пуша.

### KI-004 — Нет /health и db:migrate

**Влияние:** Runbook ссылается на несуществующие эндпоинты, что вводит в заблуждение DevOps.
**План:** Реализовать в NestJS модуль HealthCheck (Terminus) и подключить ORM для миграций.
**Исправлено:** Prisma + `prisma migrate deploy` (`db:migrate`), эндпоинт `GET /api/v1/health` с проверкой БД через Terminus.

### KI-005 — В песочнице не было кастомного seccomp-профиля

**Влияние:** Контейнеры `sandbox-worker` использовали профиль Docker по
умолчанию, который разрешает часть привилегированных сисколлов. Для
недоверенного кода это лишняя поверхность атаки: `ptrace`, `mount`,
`unshare`, `bpf`, `keyctl`, `perf_event_open`, `kexec_*`, `reboot`,
`swapon/swapoff`, `init_module`, `delete_module`, `pivot_root`, `chroot`,
`personality`, `userfaultfd` и другие.

**Исправлено:** Добавлен `sandbox/seccomp-profile.json` — allowlist с
`defaultAction: SCMP_ACT_ERRNO`. `sandbox-worker` читает профиль из
`SANDBOX_SECCOMP_PROFILE` и передаёт его демону inline JSON через
`HostConfig.SecurityOpt` (`seccomp=<json>`); путь к файлу демону не
передаётся, потому что файл живёт внутри контейнера worker. Опасные
сисколлы перечислены явными `SCMP_ACT_ERRNO`-правилами, `clone` разрешён
только без namespace-флагов, `clone3` возвращает `ENOSYS` для fallback на
`clone`. Без переменной worker работает как раньше (профиль Docker по
умолчанию); в staging переменная задана жёстко. Валидация профиля (Zod +
инварианты) выполняется при старте worker и в unit-тестах, smoke-тест
`scripts/test-sandbox.sh` проверяет утилиты, Python, Node.js/V8 и запрет
опасных сисколлов.

### KI-006 — Образ API вырос до 496 МБ из-за LangChain

**Влияние:** После оптимизации до 367 МБ (KI-001) образ снова вырос до 496 МБ: `@langchain/openai` и `@langchain/langgraph` тянут большой граф зависимостей в production-`node_modules`. Увеличиваются время сборки, передача по сети и занимаемое место. Локальный замер после добавления `dockerode` — 516 МБ.
**Исправлено (Sprint 17):** LangGraph, LangChain, адаптеры YandexGPT/GigaChat и токен-эстиматор вынесены в отдельный сервис `apps/llm-worker`. API общается с ним по внутреннему HTTP/NDJSON, инструменты и биллинг остаются в Gateway. В образе API `node_modules/@langchain` отсутствует. Дополнительно рантайм переведён на Alpine `nodejs` (~50 МБ вместо ~133 МБ официального бинарника), из образа убраны Prisma CLI и Sentry CLI/bundler-plugins для сборки source maps. Локальная сборка `docker compose build api` даёт **380 132 704 байт (~363 МиБ / 380 МБ)**, образ `llm-worker` — **466 828 059 байт (~445 МиБ)**. CI проверяет размер API-образа (лимит 400 МБ).

**Остатки:** внутренний транспорт и checkpoint'ы описаны в KI-045/KI-048; schema-мост инструментов — KI-046.

### KI-007 — Параллельные миграции при масштабировании API

**Влияние:** `prisma migrate deploy` выполнялся в `entrypoint.sh` при старте
каждой реплики API. При 2+ репликах миграции запускались одновременно; Prisma
использует advisory locks, поэтому конфликт обычно разрешался ожиданием, но
поведение зависело от версии и не гарантировало предсказуемый старт.
Дополнительно усложнялись откат и диагностика: было неясно, какая реплика
применила миграцию и завершилась ли она до перевода трафика.

**Исправлено (Sprint 15):** Добавлен one-shot Compose-сервис `db-migrate`
(`restart: "no"`), который запускает `prisma migrate deploy` на образе API и
завершается. `entrypoint.sh` API больше не содержит миграций: он только
запускает `node dist/main`. API зависит от
`db-migrate: condition: service_completed_successfully`, поэтому при
`--scale api=2` обе реплики стартуют после успешного завершения миграций.
Для Kubernetes миграции должны выполняться отдельным Job'ом с тем же образом
и `prisma migrate deploy`. Остаточные ограничения — KI-037.

### KI-008 — Сеть в песочнице включается глобально

**Влияние:** В MVP `SANDBOX_ALLOW_NETWORK=true` включал `bridge` всем вызовам
песочницы, а не только навыкам с разрешением `network`. Любой выполненный код
получал egress и мог отправить наружу переданные секреты
(`TAVILY_API_KEY`, `GITHUB_TOKEN`). Проверка `permissions` из манифеста навыка
на уровне песочницы не выполнялась.

**Исправлено (Sprint 14):** Сеть включается только по `egress_allowlist` из
манифеста навыка, объявившего инструмент, и только при `permissions:
[network]`:

- API (`apps/api/src/sandbox/egress.ts`) валидирует FQDN через Zod
  (`fqdnSchema`: нижний регистр, без схемы/порта/wildcard, максимум 50
  уникальных доменов) и передаёт worker'у `{network, egressAllowlist}`.
  Пустой/отсутствующий список → `network: 'none'`; legacy-флаги
  `ALLOW_NETWORK`/`SANDBOX_ALLOW_NETWORK` сеть больше не включают.
- `sandbox-worker` независимо валидирует payload Zod и при
  `bridge` + пустом allowlist принудительно ставит `none`. При непустом
  allowlist контейнер запускается с `NET_ADMIN`/`SETUID`/`SETGID`, root
  entrypoint `sandbox/egress-setup.sh` применяет iptables: loopback + DNS
  `127.0.0.11:53`, `ACCEPT` tcp 80/443 только на IP, в которые резолвнуты
  домены allowlist, политика `OUTPUT/INPUT/FORWARD DROP`, затем `su-exec
  65534:65534` и запуск кода.
- Тесты: API (mock axios) — без allowlist сеть `none` даже при
  `SANDBOX_ALLOW_NETWORK=true`, с allowlist — `bridge` и forwarded-список,
  wildcard/схема/порт/IP отклоняются до HTTP-вызова; worker — чистые тесты
  конфигурации контейнера и правил iptables. Интеграционно (Docker):
  allowlisted `example.com` → HTTP 200, не-allowlisted домен → блокировка,
  код выполняется от uid 65534 с `CapEff=0`.

**Остаточные риски:** см. KI-028 (IP-pinning, DNS-туннель, ip6tables) и
KI-029 (обход allowlist через интерпретаторы).

### KI-009 — Интерфейс A/B-тестирования промптов не реализован

**Влияние:** В Control Plane можно создать новую версию промпта, но нельзя
запустить A/B-эксперимент, разделить трафик между версиями и сравнить
метрики. Это закрывает только часть блока 2 спецификации Control Plane
(«Версионирование и откат»), но не «A/B-тестирование на реальном трафике».

**Обход:** Переключать активную версию вручную и оценивать результат по
чату и логам; A/B-тесты проводить вне UI.

**План:** Добавить в раздел «Промпты» выбор версий, доли трафика, метрики
(latency, cost, пользовательский feedback) и остановку эксперимента. Для
этого сначала нужен API экспериментов и привязка запросов к варианту.

### KI-010 — LlmRouter использует упрощённую логику выбора

**Влияние:** `LlmRouterService` выбирал один активный маршрут с наименьшим
`priority` для всех запросов. Не было классификации задачи, fallback-цепочки
при 429/5xx, бюджетных предохранителей. Если выбранный провайдер недоступен,
запрос завершался ошибкой, а не переключался на резервный маршрут.

**Исправлено (Sprint 16, LLM Router v2):**

- `LlmRoute` получил `taskType` (default `chat`) и `dailyCostLimit`
  (₽/сутки, NULL — без лимита); миграция `add_llm_router_v2`. CRUD/DTO и аудит
  поддерживают новые поля.
- `LlmRouterService.selectRoutes(taskType, now)` возвращает цепочку активных
  маршрутов задачи по `priority asc`. Для маршрутов с лимитом расход за
  текущие UTC-сутки считается по append-only Ledger
  (`LedgerEntry.llmRouteName`, который заполняется при LLM-списании); при
  `spend >= limit` маршрут исключается с событием
  `gen_ai.router.budget_exceeded`. Если все маршруты исчерпаны — 503
  `errors.llm_unavailable`; пустая таблица по-прежнему означает env-fallback.
- `LlmService` принимает цепочку (`LlmRouteSelection | readonly
  LlmRouteSelection[]`), при retriable-ошибке провайдера (HTTP 429/5xx,
  таймаут/AbortError/ETIMEDOUT/ECONNRESET) переключается на следующий
  маршрут и логирует `gen_ai.router.fallback {from,to,reason,taskType}`.
  Токены резервируются один раз до попыток, reconcile/refund — один раз;
  стрим переключается только до первой дельты; исчерпание всей цепочки —
  refund + 502 `errors.llm_unavailable`. Ошибки 400/401/403 не ретраятся.
- `gen_ai.usage` дополнен `gen_ai.route` (и `gen_ai.usage.cost`), web
  распознаёт `errors.llm_unavailable` и показывает локализованное сообщение.

**Остатки:** 502 для одиночного маршрута/env-fallback исправлен (KI-044);
A/B-тестирование не входит (KI-009).

### KI-011 — MCP-серверы Ozon и Wildberries работают в режиме заглушки

**Влияние:** Навыки `ozon-seller` и `wb-seller` объявляют инструменты
`ozon_mcp_call` и `wb_mcp_call`, но реальные MCP-серверы маркетплейсов не
подключены. Инструменты возвращают фиксированные демонстрационные данные
(например, `sales: 15000`, `items: 42`) и не выполняют реальных операций с
карточками, заказами или отзывами. Пользователь может принять такие данные
за реальные.

**Обход:** Использовать навыки только для демонстраций и тестирования
сценариев. В ответах ассистента явно помечать данные как демонстрационные;
не применять инструменты в реальных продажах.

**План:** Подключить Ozon Seller API и Wildberries API через MCP-клиент,
добавить аутентификацию по ключам продавца, таймауты, retry и маппинг
ошибок провайдера. До этого считать MCP-слой заглушкой.

### KI-012 — Навыки для внешних API работают в режиме Mock

**Влияние:** Навыки `messenger-connector`, `google-workspace`,
`midjourney-api`, `ozon-seller` и `wb-seller` возвращали фиктивные данные
вместо реальных ответов внешних сервисов. Агенты строили ответы и отчёты на
демонстрационных значениях, а пользователь мог принять их за реальные.

**Исправлено (Sprint 18) для `messenger-connector` и `google-workspace`:**

- `send_message` вызывает Telegram Bot API (`sendMessage`) с inline-клавиатурой
  (до 8 кнопок с `url`/`callbackData`); токен бота берётся из подключения
  пользователя (`TelegramBot`, шифруется AES-256-GCM), иначе — системный
  `TELEGRAM_BOT_TOKEN`. Неподключённые каналы (`vk`, `whatsapp`) отклоняются
  400 `errors.invalid_request`.
- Входящие обновления Telegram приходят через webhook
  (`POST /api/v1/webhooks/telegram` и alias `/integrations/telegram/webhook`):
  секрет проверяется constant-time, `update` валидируется Zod, сообщение
  маршрутизируется в `ChatService` по привязке `TelegramChatLink`, ответ
  уходит обратно в чат; callback-кнопки подтверждаются `answerCallbackQuery`.
- `google_sheets_append` добавляет строки через Sheets API v4
  (`values:append`, `USER_ENTERED`), `google_docs_create` создаёт документ и
  вставляет текст через Docs API `batchUpdate`, `google_calendar_create`
  создаёт событие в Calendar API v3. Все вызовы идут от имени пользователя:
  OAuth-токены хранятся зашифрованными (`GoogleCredential`), access-token
  обновляется по `refresh_token` за минуту до истечения, при 401 — один
  принудительный refresh и повтор.
- OAuth-flow: `GET /integrations/google/authorize` (и alias
  `authorization-url`) отдаёт URL согласия с подписанным HMAC `state`,
  callback обменивает код, сохраняет токены и email; при заданном
  `GOOGLE_OAUTH_SUCCESS_REDIRECT` возвращает браузер в настройки.
- Rate limit 429 обрабатывается экспоненциальным backoff с учётом
  `Retry-After`/`parameters.retry_after`; после исчерпания — 429
  `errors.provider_rate_limited`, 5xx/сеть — `errors.provider_unavailable`,
  401/403 — `errors.provider_auth_required`, отсутствие ключей —
  `errors.provider_not_configured`. Egress ограничен allowlist
  (`OUTBOUND_ALLOWLIST`), внешние адреса — только https.

**Остаток:** `midjourney-api`, `ozon-seller`, `wb-seller` по-прежнему Mock —
вынесено в KI-055 (Sprint 19).

### KI-013 — Agent Gateway покрывает только базовые regex-правила

**Влияние:** Изначально `AgentGatewayService` проверял только два сценария:
`execute_sandbox_code` с `rm -rf /` и `web_search` со словами
`password`/`secret`. Правила были основаны на регулярных выражениях и не
учитывали обфускацию, другие опасные команды, структуру аргументов,
источник вызова, роль пользователя и контекст задачи.

**Исправлено (Sprint 14):** `AgentGatewayService` стал декларативным policy
engine (`apps/api/src/security/policy/`):

- реестр `tool-policies.ts` — strict Zod-схемы аргументов для всех 18
  инструментов (лишние ключи и превышение лимитов отклоняются), требуемые
  разрешения навыка, роли, категория egress и режим taint; неизвестный
  инструмент блокируется (deny by default);
- `shell-analyzer.ts` — структурный разбор shell (токенизация, кавычки,
  экранирования, `${IFS}`, ANSI-C `$'\x..'`, разбиение по `; && || | &`),
  allowlist бинарников для `exec` и песочницы, запрет `eval`/вложенных
  shell/command substitution/`rm -rf`/`child_process`/`subprocess`/
  чтения `.env` и `/proc/*/environ`;
- `secret-taint.ts` — taint tracking: секрето-подобные значения из
  `web_search`/внешних MCP блокируются при передаче в `exec`, песочницу,
  MCP и каналы отправки; в поисковом запросе — маскируются `[REDACTED]`;
- учитываются роль пользователя (shell-инструменты недоступны `guest`,
  навыки с `secrets` — только `admin`/`owner`) и контекст навыка
  (`network` + `egress_allowlist` для сетевого кода);
- блокировка отдаёт клиенту единый JSON (`errors.policy_blocked`) и
  пишется в append-only `AuditLog` (`action: agent_gateway.blocked`) без
  значений аргументов и секретов.

**Проверка обходов:** таблица тестов `agent-gateway.service.spec.ts` ловит
варианты, которые старый regex пропускал: `rm -fr /`,
`rm --recursive --force /`, `r''m -rf /`, `r\m -rf /`,
`rm${IFS}-rf${IFS}/`, `eval 'rm -rf /'`, `bash -c ...`,
`curl ... | sh`, `wget ... | bash`,
`require('child_process')`, `os.system`, чтение `.env`,
`fs.readFileSync('.env')`, `/proc/self/environ`. Poisoned-данные из
`web_search` проверены интеграционными тестами `chat.service.spec.ts`.
Всего по policy engine — 152 unit-теста.

### KI-014 — Content/HR/Legal навыки работают в режиме Mock

**Влияние:** `dzen-article` создаёт Markdown-черновик через `publish_to_dzen`,
но не публикует статью в Дзен: публичного API для внешних систем нет.
`fact-checker`, `resume-screener` и `document-analyzer` объявляют
инструменты `check_facts`, `screen_resume` и `extract_document_data`, но не
обращаются к реальным сервисам. Проверка фактов, оценка резюме и извлечение
данных из договоров возвращают фиксированные демонстрационные результаты;
для `dzen-article` при этом действует Pay-per-Outcome и HITL-одобрение.

**Обход:** Использовать навыки только для демонстраций и E2E-сценариев,
явно помечать результаты как демонстрационные и не применять их для
публикации контента или кадровых/юридических решений. Черновик Дзена
загружать в редакцию вручную.

**План:** Подключить реальные API и адаптеры: публикацию в Дзен, источники
фактчекинга, HR/ATS-системы и парсеры документов. Добавить проверку
качества результата, аудит вызовов и обработку ошибок провайдеров. До
этого считать навыки Mock-заглушками.

**Вне Sprint 18:** спринт закрывает Telegram и Google Workspace (KI-012);
контент/HR/legal-навыки остаются Mock и закрываются в Sprint 20 согласно
`docs/development/SPRINTS-14-PLUS.md`.

**Исправлено (Sprint 20):** Mock-ответы удалены, инструменты работают на
реальных данных:

- `check_facts` ищет утверждения через Tavily (`POST /search`, ключ
  `TAVILY_API_KEY`, домен `api.tavily.com` в `OUTBOUND_ALLOWLIST`), сравнивает
  найденные источники по пересечению значимых слов и по числам и возвращает
  вердикт `supported` (два независимых домена и больше), `single_source`,
  `contradicted` или `unverified`. В ответе есть ссылки, цитаты и `confidence`;
  без источников факт не «подтверждается».
- `screen_resume` разбирает настоящий текст резюме: контакты, навыки (словарь +
  раздел «Навыки»), опыт по диапазонам дат (пересечения не суммируются
  дважды), образование и языки. Оценка `score` появляется только при переданных
  требованиях и объясняется формулой 70 % навыки / 30 % опыт; `score: null`
  вместо выдуманных «85/100».
- `extract_document_data` извлекает реквизиты договора (суммы с валютой, даты,
  стороны, номер, ИНН/КПП/ОГРН, подписант) из текста, PDF, DOCX, TXT или скана;
  каждое значение содержит `raw` и контекст, валидация дат — календарная.
- `pdf-extractor` (`extract_pdf`) разбирает PDF без внешних бинарников: объекты,
  `/FlateDecode`, object streams PDF 1.5+, дерево страниц, текстовые операторы,
  `ToUnicode` CMap (включая кириллицу) и таблицы по геометрии колонок.
- `docx-writer` (`write_docx`) собирает валидный OOXML-пакет (`[Content_Types]`,
  `document.xml`, `styles.xml`) и отдаёт путь к реальному `.docx`; `body` —
  заголовки, абзацы, списки и таблицы с границами.
- `ocr-smart-engine` (`ocr_document`) вызывает Smart Document Engine по
  `OCR_API_URL` (Zod-валидация ответа, опрос асинхронной задачи) и при сбое
  переключается на Tesseract в песочнице.
- `dzen-article` по-прежнему отдаёт Markdown-черновик (публичного API Дзена нет),
  но HITL и Pay-per-Outcome закреплены тестом `agent/dzen-article.spec.ts`:
  манифест требует одобрения, hold на 100 ₽ создаётся до вызова и фиксируется
  только при успешной записи черновика.
- Проверки: 1160+ unit-тестов, включая разбор кириллического PDF, round-trip
  DOCX → `document-analyzer`, подмену источников Tavily (nock) и отказ
  провайдера без списания средств.

**Остатки:** контракт вендорского OCR и ограничения PDF/DOCX — KI-068/KI-069;
хранение и антивирус для загруженных файлов — KI-070.

### KI-015 — Финансовые навыки работают в режиме Mock

**Влияние:** Навыки `unit-economics`, `profit-leak-detector`,
`price-monitor` и `fraud-shield-audit` возвращали фиксированные
демонстрационные значения вместо реальных расчётов и данных
маркетплейсов. `profit-leak-detector` списывал Pay-per-Call, а
`fraud-shield-audit` — Pay-per-Outcome с обязательным одобрением, поэтому
пользователь мог заплатить за демонстрационный результат.

**Исправлено (Sprint 19):** Инструменты переписаны на реальные MCP-вызовы
Ozon/WB (`FinanceDataService` + `FinanceToolsService`):

- `calculate_unit_economics`: Ozon — `ozon_finance_totals`,
  `ozon_analytics` (revenue/ordered_units/returns по SKU),
  `ozon_get_prices`; WB — `wb_finance_report` (комиссия, логистика,
  возвраты, штрафы, удержания, хранение, эквайринг, `ppvzForPay`).
  Расходы Ozon распределяются по доле выручки SKU (KI-061), маржа без
  `cost` не считается.
- `detect_profit_leaks`: Ozon — `ozon_finance_totals` и
  `ozon_finance_transactions` (реальные accruals: отрицательные начисления
  группируются по категориям, топ-5 — `transaction_anomaly`); WB —
  `wb_deductions`, штрафы/удержания из `wb_finance_report`,
  `wb_prices_quarantine`. Возвращает `findings` с суммами и источниками.
- `monitor_competitor_prices`: Ozon — своя цена (`ozon_get_prices`) и цена
  конкурента (`ozon_pricing_competitor_prices` по `productId`); WB — своя
  цена (`wb_prices_list`), конкурентные цены провайдер не отдаёт
  (`competitorUnavailableReason`).
- `audit_fraud_risk`: Ozon — `ozon_ad_campaigns` +
  `ozon_ad_statistics_expenses`; WB — `wb_advert_list`, `wb_advert_costs`,
  `wb_deductions`, `wb_analytics_antifraud`. Проверяется наличие ERID/UTM в
  сырых данных кампании (KI-062).
- Если MCP не вернул данные: непригодный ответ — 502 `errors.mcp_provider`;
  валидный пустой ответ — `dataAvailable:false` с причиной. Фейковых
  `sales/штрафов/цен` больше нет.
- Оплата: Pay-per-Call списывается через BAL после успешного получения
  данных, Pay-per-Outcome (`fraud-shield-audit`, `dzen-article`) — hold до
  подтверждения и capture после успеха; при ошибке провайдера hold
  отменяется.
- Покрыто тестами: `finance-data.service.spec.ts` (парсинг/ошибки
  провайдера), `finance-tools.service.spec.ts` (расчёты по фикстурам
  реальных MCP-ответов), `agent-tools.service.spec.ts` (списание после
  вызова и отсутствие списания при ошибке), `agent-runtime.service.spec.ts`
  (PPC/PPO через BAL), `mcp-gateway.spec.ts` (strict-схемы действий).

**Остаток:** детализация Ozon до SKU (KI-061) и ERID/UTM (KI-062).

### KI-016 — В staging Grafana использовала admin/admin, Prometheus был без авторизации

**Влияние:** Панели мониторинга были доступны с дефолтным паролем Grafana
`admin/admin`, а Prometheus не проверял креды. Любой, кто получил доступ к
staging-сети или SSH-туннелю, мог читать метрики и менять дашборды.

**Исправлено:** Caddy на staging закрывает `/grafana/` и `/prometheus/`
HTTP Basic Auth. Prometheus дополнительно использует нативный
`web.config.file` с `basic_auth_users` и bcrypt-хэшем; self-scrape и
provisioned datasource Grafana передают те же креды. Пароли и хэши задаются
только через `MONITORING_BASIC_AUTH_*`/`GRAFANA_ADMIN_*` в `.env`, пустые и
известные дефолтные значения останавливают запуск. Проверка: без кредов
`401`, с корректными кредами `200`; `/api/v1/health` не затронут.

### KI-017 — Бэкапы БД накапливались без retention-политики

**Влияние:** `scripts/backup-db.sh` создавал дампы, но не удалял старые,
поэтому каталог `backups/` рос без ограничений и мог забить диск. Не было
проверки свободного места и явной ошибки при неуспешном `pg_dump`.

**Исправлено:** Добавлен `scripts/rotate-backups.sh`: хранит
`BACKUP_KEEP_DAYS` дней, но оставляет не меньше `BACKUP_KEEP_MIN` последних
дампов, удаляет только просроченные файлы сверх минимума, логирует каждое
удаление и поддерживает `--dry-run`/`-DryRun`. `backup-db.sh` проверяет
`BACKUP_MIN_FREE_MB`, пишет во временный `.partial` и запускает ротацию
только после успешного непустого дампа.

### KI-018 — У мониторинга общие статические креды

**Влияние:** Grafana и Prometheus на staging закрыты HTTP Basic Auth, но
используют один общий логин `MONITORING_BASIC_AUTH_USER` без SSO, ролей и
per-user аудита. При утечке пароля нужно вручную сменить
`MONITORING_BASIC_AUTH_PASSWORD` и `MONITORING_BASIC_AUTH_HASH`. Grafana
дополнительно требует отдельный вход `GRAFANA_ADMIN_*`, то есть у панели
два слоя аутентификации.

**Обход:** Хранить пароли только в `.env`/секретах хоста, не переиспользовать
их с другими сервисами, выдавать доступ через VPN или SSH-туннель. При
смене пароля пересоздавать bcrypt-хэш и перезапускать `prometheus`,
`grafana` и `caddy`.

**План:** Перейти на OIDC/LDAP в Grafana, включить auth proxy с передачей
пользователя из Caddy и роли только для чтения для Prometheus либо оставить
единый SSO-провайдер. Добавить аудит входов и процедуру ротации секретов.

### KI-019 — Бэкапы БД хранятся только локально

**Влияние:** `scripts/backup-db.sh` и `scripts/rotate-backups.sh` ограничивали
рост диска и защищали от ошибочного удаления, но копии лежали в одном
каталоге `BACKUP_DIR`. Потеря или шифрование этого каталога (диск, хост,
ransomware) лишала возможности восстановить Ledger. Автоматическая проверка
восстановления не выполнялась.

**Исправлено (Sprint 15):** `backup-db.sh` после успешного локального дампа и
локальной ротации вызывает `scripts/upload-backup.sh`, который выгружает
дамп через `rclone` в S3-совместимое хранилище. Настройка — `BACKUP_S3_*`;
без `BACKUP_S3_BUCKET` offsite выключен и локальный сценарий не меняется.
Retention offsite — `BACKUP_S3_KEEP_DAYS` (по умолчанию как
`BACKUP_KEEP_DAYS`). При недоступном S3 локальный дамп сохраняется, скрипт
печатает ошибку и возвращает `1`. `scripts/restore-drill.sh` скачивает
последний offsite-дамп, восстанавливает его во временную БД, проверяет
`User`/`LedgerEntry` и удаляет БД; `0` возвращается только при успехе.
Остаточные ограничения — KI-035/KI-036.

### KI-020 — Дневной жёсткий лимит токенов можно превысить конкурентными запросами

**Влияние:** `LlmService` проверял лимит чтением счётчика перед вызовом LLM и
инкрементировал его после ответа без условия. Несколько одновременных
запросов проходили проверку и суммарно превышали `User.dailyTokenLimit`, то
есть бюджет на токены мог быть перерасходован.

**Исправлено:** Списание переведено на атомарный `User.updateMany` с условием
`dailyTokensUsed + tokens <= dailyTokenLimit`. Если `count === 0`, вызов
отклоняется с `429` в едином JSON-формате
`{ statusCode, error, code, message }` (`code: errors.daily_token_limit`).
Мягкий порог 80% лимита остался предупреждением в логе
(`gen_ai.budget.soft_limit`), а не отказом. Покрыто тестами: конкурентный
`Promise.all` из 10 вызовов по 300 токенов при лимите 1000 даёт ровно 3
успеха и 7 отказов, счётчик остаётся 900 ≤ 1000; то же проверено на реальном
Postgres.

### KI-021 — Жёсткий лимит токенов проверялся после ответа модели

**Влияние:** Атомарное списание выполнялось по `usage` уже сгенерированного
ответа. В нестриминговом режиме клиент получал `429` без ответа, но токены
у провайдера уже потрачены. В стриминге дельты уходили клиенту до списания,
поэтому при превышении лимита клиент видел часть текста и затем ошибку;
токены сверх лимита в `dailyTokensUsed` не попадали — счётчик не превышал
лимит, но фактический расход был выше учтённого.

**Исправлено (Sprint 15):** Reserve-before-call во всех четырёх путях
(OpenAI non-stream/stream, native adapter non-stream/stream):

- до вызова модели атомарный `User.updateMany` резервирует
  `estimateMessagesTokens(messages, systemPrompt) + reservedOutput`
  (`LLM_RESERVE_OUTPUT_TOKENS`, default 4096) с условием
  `dailyTokensUsed <= dailyTokenLimit - reserved`; если места нет —
  `429` (`errors.daily_token_limit`) **до** вызова провайдера и до первой
  дельты; мягкий порог 80% логируется (`gen_ai.budget.soft_limit`);
- после ответа — reconcile: `actual = usage.total_tokens`;
  `delta = actual - reserved`; отрицательная разница возвращается атомарным
  decrement, положительная добавляется с проверкой лимита; при переполнении
  счётчик клампится к лимиту (`gen_ai.budget.reconcile_overflow`), жёсткий
  лимит не превышается;
- при ошибке провайдера до получения usage резерв откатывается;
- конкурентный тест: `Promise.all` из 10 вызовов, помещается ровно N —
  успешных ровно N, остальные получают 429 до вызова модели, счётчик не
  превышает лимит.

Остаточные ограничения — KI-031 (ранний abort стрима) и KI-032 (приближение
оценки prompt-токенов).

### KI-022 — Стриминг GigaChat может не содержать usage

**Влияние:** Если провайдер не присылает финальный чанк с `usage`,
`GigaChatAdapter.chatStream` возвращал нулевые `usage_metadata`. Тогда не
инкрементировался дневной счётчик токенов и не начислялась стоимость LLM,
хотя токены израсходованы.

**Исправлено (Sprint 15):** `LlmService.resolveUsage` при
`total_tokens === 0` оценивает prompt (по отправленным сообщениям) и
completion (по сгенерированному тексту) через
`apps/api/src/llm/token-estimator.ts` (js-tiktoken `cl100k_base`, эвристический
fallback при недоступности словаря). Оценка используется в reconcile
дневного лимита и в `chargeLlmUsage`; в лог пишутся `gen_ai.usage` с
`gen_ai.usage_estimated: true` и событие `gen_ai.usage.fallback`. Когда usage
есть, поведение прежнее (оценка не используется). GigaChat тарифицирует input
и output одинаково, поэтому для стоимости важен суммарный объём токенов.

Точность приближения зафиксирована в KI-032.

### KI-023 — Нет API чтения RAG-памяти

**Влияние:** В API были только запись памяти (`MemoryService.remember`),
поиск для промпта (`buildContext`) и удаление
(`DELETE /api/v1/chat/memory`), но не было эндпоинта, который вернул бы
пользователю его записи. Поэтому раздел «Память» на странице настроек скрыт
feature-флагом `VITE_RAG_MEMORY_ENABLED` и не делал запросов.

**Исправлено (Sprint 14):** Реализован read-API `GET /api/v1/chat/memory`
(`apps/api/src/memory/memory.controller.ts`):

- контракт `{ items: [{ id, content, createdAt }], total: number }`,
  `createdAt` — ISO 8601, сортировка `createdAt desc`;
- пагинация `limit` 1..100 (default 20) и `offset` 0..10000 (default 0);
  query и ответ валидируются Zod, неизвестные параметры → 400
  (`errors.invalid_request`), расхождение ответа с контрактом → 500;
- права: только записи текущего пользователя (`where: { userId }` из JWT),
  `userId` из query не принимается; без аутентификации — 401;
- запись/поиск/удаление памяти не менялись.

UI-часть уже была готова: `apps/web/src/lib/rag-memory.ts` валидирует ответ
Zod, панель показывает загрузку/пустоту/ошибку/повтор. Проброс build-arg в
Docker-сборке выполнен (KI-030); осталось включить
`VITE_RAG_MEMORY_ENABLED=true` в `.env` после проверки на реальных данных.

### KI-024 — У записей памяти нет метаданных

**Влияние:** Модель `MemoryChunk` хранит только `id`, `userId`, `content`,
`embedding` и `createdAt`. Тип записи, источник (диалог/сообщение),
`updatedAt` и confidence/релевантность отсутствуют, поэтому UI показывает
только краткое содержание, фактический тип «фрагмент памяти» и дату
создания. Требуемые по макету «источник» и «дата обновления» вывести
достоверно нельзя; релевантность (косинусное расстояние) считается только
в момент поиска и не сохраняется.

**Обход:** Считать текущий список ознакомительным: показывать только
реальные поля и явно сообщать в интерфейсе, что источник, тип и
релевантность появятся позже. Не использовать дату создания как дату
обновления.

**План:** Добавить в `MemoryChunk` поля `source`, `kind`, `updatedAt` (или
связь с `Message`/`Conversation`), миграцию и возврат их в read-API; после
этого вывести бейджи типа/источника, дату обновления и (опционально)
нормализованную релевантность с явной подписью, что это не «точность».

### KI-025 — Не все ошибки API маппились в UI по `code`

**Влияние:** Часть ошибок API отдаёт машиночитаемый `code`, но UI переводил
в i18n только `daily_token_limit`, `insufficient_funds` и MCP-коды.
`errors.invalid_request` и `errors.policy_blocked` показывались сырым
русскоязычным текстом бэкенда (на EN не переводились), а старые ошибки
marketplace кода не имеют — для них нужен текстовый fallback.

**Исправлено:** В `apps/web/src/lib/chat-errors.ts` добавлены коды
`errors.invalid_request` и `errors.policy_blocked` (категории
`invalidRequest`/`policyBlocked`); код имеет приоритет над текстом, сообщения
переводятся через i18n (`chat.errors.invalidRequest`,
`chat.errors.policyBlocked`, а также top-level `errors.invalid_request`/
`errors.policy_blocked` на случай, если бэкенд присылает ключ строкой).
Текстовые маркеры и HTTP 429 сохранены как fallback для старого API. Покрыто
тестами в `apps/web/src/lib/chat-errors.test.ts`.

**Остаток (не дефект маппинга):** `insufficient_funds` может приходить без
`code` (текстовый fallback). Новые коды, которые появляются в
`apps/api/src/i18n/error-keys.ts`, должны добавляться в тот же switch и
i18n-словари.

**Дополнено (Sprint 17):** Добавлен код `errors.marketplace_unavailable`
(`ERROR_KEYS.marketplaceUnavailable`, `marketplaceUnavailableError()` в
`apps/api/src/common/api-error.ts`). API отдаёт его с HTTP 503, когда
marketplace-инструмент (Ozon/WB) вызван без ключей провайдера, поэтому UI
больше не полагается на текстовый маркер для этого случая; текстовые маркеры
MCP сохранены как fallback для старого API.

### KI-026 — Остаточные ограничения seccomp-профиля

**Влияние:** `sandbox/seccomp-profile.json` содержит `SCMP_ARCH_X86_64` и
рассчитан на linux/amd64 (CI и staging). На arm64 Docker не сможет применить
этот профиль, поэтому в staging нужен amd64-хост, а локально профиль по
умолчанию выключен. Профиль — совместимый allowlist, а не по-навыковая
минимизация: он покрывает Node.js/V8, Python и CLI-утилиты, но остаётся
шире, чем нужно конкретному навыку. Smoke-тест применяет тот же профиль
через `docker run`, а не инспектирует `HostConfig.SecurityOpt` контейнера,
созданного worker; передача профиля в worker проверяется unit-тестом.
Файл читается при старте, поэтому после правки профиля нужен перезапуск
`sandbox-worker` (пересоздание контейнеров не требуется).

**Обход:** Держать staging на amd64; после изменения профиля выполнять
`docker compose restart sandbox-worker`; при проблемах совместимости
временно убрать `SANDBOX_SECCOMP_PROFILE` (в staging — только аварийно,
с фиксацией инцидента). Не расширять allowlist без smoke-теста.

**План:** Добавить профили для arm64 (или генерировать архитектуру из
базового профиля Docker), e2e-проверку `docker inspect` реального
контейнера worker в CI и отдельные минимальные профили под группы навыков.

### KI-027 — Неизвестные MCP-действия валидируются только структурно

**Влияние:** MCP Gateway валидировал `action` и `params` Zod-схемой до
отправки на MCP-сервер, но список действий MCP-сервера (`tools/list`) не
использовался: неизвестное действие проверялось только структурно (плоские
примитивы, лимиты размера), поэтому опечатка в имени действия доходила до
MCP-сервера и возвращалась его ошибкой (502), а не 400.

**Исправлено (Sprint 16):**

- `McpClient.listTools()` выполняет JSON-RPC `tools/list` в существующей
  SSE-сессии (тот же таймаут/typed errors), ответ валидируется Zod-схемой
  `{ tools: [{ name, description?, inputSchema? }] }`.
- `McpGateway` принимает `listTools`, лениво (один раз на инстанс, кеш
  промиса) получает набор действий и отклоняет неизвестное действие
  `400 errors.invalid_request` до `client.callTool`. Strict-схемы известных
  ozon/wb-действий применяются после discovery; структурная валидация — до.
- Если `tools/list` недоступен/упал, gateway не падает: structural-only как
  раньше + однократный лог `mcp.tools_list_unavailable` (провайдер и
  маскированное сообщение). Пустой `tools/list` означает «сервер не
  объявляет действий» — все действия отклоняются.
- `LlmService` кеширует gateway на инстанс `McpClient`, поэтому в production
  discovery выполняется один раз за жизнь SSE-сессии.

**Остаток:** набор действий кешируется на время SSE-сессии; изменения
`tools/list` на сервере подхватываются после переподключения (KI-043).

### KI-028 — Egress по IP на старте контейнера

**Влияние:** Egress-gateway резолвил FQDN из `egress_allowlist` в IP на старте
контейнера и разрешал tcp 80/443 только на эти IP. DNS-туннель был возможен
(`127.0.0.11:53` открыт всему коду), `ip6tables` настраивался best-effort
(IPv6-трафик мог остаться под default-policy хоста), а запись `/etc/hosts`
не работала при `ReadonlyRootfs: true`.

**Исправлено (Sprint 16):**

- DNS-tunneling закрыт: DNS (udp/tcp 53) разрешён только root-entrypoint
  (`-m owner --uid-owner 0`), а для кода под uid 65534 действует явный DROP
  по исходному порту назначения (`conntrack --ctorigdstport 53`) — правило
  стоит до generic loopback ACCEPT, поэтому loopback его не обходит. Docker
  DNATит `127.0.0.11:53` на локальный порт, поэтому `--dport 53` не
  использовался (найден и исправлен реальный bug).
- `ip6tables` настраивается строго: при наличии IPv6-стека
  (`/proc/net/if_inet6`) обязательны `-P INPUT/FORWARD/OUTPUT DROP`,
  loopback/ESTABLISHED/DNS-root правила; ошибка ip6tables → worker завершает
  запуск песочницы (fail closed). Без IPv6 — skip с логом.
- Read-only rootfs: worker резолвит `egress_allowlist` через `node:dns` и
  передаёт `HostConfig.ExtraHosts` (`<fqdn>:<ipv4>`), Docker инжектит записи
  в `/etc/hosts` даже при `read_only: true`; проверено на Docker
  (`getent hosts` + `curl` → 200, `nslookup` → fail). Запись `/etc/hosts` из
  entrypoint остаётся best-effort для dev.
- Разрешённые домены резолвятся без DNS для кода; неразрешённые не
  резолвятся вовсе.

**Остаточные риски (KI-042):** SNI/Host-фильтрации нет (allowlist — IP:port),
DNS rebinding/SSRF через разрешённый FQDN, ротация IP/CDN и двойной резолв
worker/entrypoint, ExtraHosts только IPv4.

### KI-029 — Структурный анализатор shell не заменяет песочницу

**Влияние:** `shell-analyzer.ts` — эвристический токенизатор, а не полный
POSIX-shell-парсер: он ловит обфускации (`r''m`, `$IFS`, ANSI-C,
command substitution), опасные builtins и allowlist бинарников, но не
доказывает безопасность произвольного кода. `python3 -c` или `node -e`
могут построить shell-команду или HTTP-клиент внутри процесса; allowlist
бинарников ограничивает только прямые вызовы команд. Поэтому policy engine
— слой defense-in-depth, границей безопасности остаётся контейнер
(read-only rootfs, CapDrop, seccomp, egress-allowlist).

**Обход:** Считать анализатор «быстрым отказом», а не гарантией; держать
`execute_sandbox_code`/`exec` за HITL (`requiresApproval`) для навыков,
которые объявляют `shell`; не передавать в песочницу лишние секреты.

**План:** Добавить AST-разбор для Python/Node (`-c`/`-e`/stdin) и запрет
запуска интерпретаторов с inline-кодом или ограничить их отдельным
инструментом; вынести минимизацию системных вызовов в профили навыков.

### KI-030 — `VITE_RAG_MEMORY_ENABLED` не пробрасывался в Docker-сборку

**Влияние:** `apps/web/Dockerfile` принимает build-arg
`VITE_RAG_MEMORY_ENABLED` (default `false`), но `docker-compose.yml`
передавал в сборку только `VITE_API_URL`. Поэтому в Docker-развёртывании
панель RAG-памяти на странице настроек оставалась скрытой, хотя
API-эндпоинт уже был реализован (KI-023).

**Исправлено:** Сервис `web` в `docker-compose.yml` и
`docker-compose.staging.yml` получает
`build.args.VITE_RAG_MEMORY_ENABLED: ${VITE_RAG_MEMORY_ENABLED:-false}`;
в `.env.example` добавлена закомментированная переменная с пояснением.
Проверено `docker compose build web` в двух режимах: без переменной чанк
панели в образ не попадает (`rag-memory` не находится), с
`VITE_RAG_MEMORY_ENABLED=true` панель есть в `SettingsPage-*.js`. Существующие
build-args (`VITE_API_URL`) и остальные сервисы не затронуты
(`docker compose config`).

**Обход:** Не требуется: переменная задаётся в `.env` (или окружении) перед
`docker compose build web`; изменение значения влечёт пересборку образа.

### KI-031 — Ранний abort стрима оставляет резерв не сверенным

**Влияние:** Резерв токенов снимается до вызова модели и сверяется после
ответа (`reconcile`). Если клиент оборвал WebSocket-стрим до завершения
генерации (или native-адаптер упал после отправки запроса, но до получения
`usage`), фактический `usage` неизвестен. Консервативно резерв не
возвращается: `dailyTokensUsed` остаётся завышенным до ленивого сброса суток.
Жёсткий лимит при этом не превышается, деньги списываются только по
полученному usage (Ledger не затрагивается).

**Обход:** Для критичных к дневному лимиту сценариев не обрывать стрим
вручную; при инциденте — дождаться суточного сброса или скорректировать
`User.dailyTokensUsed` администратором.

**План:** Обрабатывать отмену/abort через `finally`-refund (если usage ещё не
получен) и/или `AbortSignal` в провайдерских вызовах; добавить метрику
`gen_ai.budget.reservation_orphaned`.

### KI-032 — Приблизительная оценка prompt-токенов

**Влияние:** Перед вызовом модели prompt-токены оцениваются `cl100k_base`
(js-tiktoken) плюс эвристический fallback; схемы инструментов и особенности
токенизаторов провайдеров (GigaChat, YandexGPT) не учитываются. Обычно оценка
даёт запас (reserved output 4096), но при недооценке фактический `usage`
больше резерва: при отсутствии места счётчик клампится к лимиту
(`gen_ai.budget.reconcile_overflow`), и учтённый расход может отличаться от
фактического в пределах остатка лимита.

**Обход:** Считать `dailyTokensUsed` ограничителем доступа, а точный расход —
по Ledger/кабинету провайдера; при необходимости увеличить
`LLM_RESERVE_OUTPUT_TOKENS`.

**План:** Провайдерские токенизаторы (или `tiktoken`-кодировки конкретной
модели), учёт tool-схем в оценке prompt, метрика расхождения
`actual - reserved`.

### KI-033 — Нет TTL для ожидающих одобрения

**Влияние:** Если пользователь не отправил `approve_action` (закрыл вкладку,
забыл), запись `PendingApproval` оставалась `pending`, а escrow-hold —
`PENDING` в Ledger: сумма замораживалась в `heldBalance` бессрочно.
Checkpoint графа тоже сохранялся.

**Исправлено (Sprint 16):**

- `PendingApproval.expiresAt` (миграция `add_pending_approval_expiry`);
  TTL задаётся `HITL_APPROVAL_TTL_HOURS` (default 24 ч) и пересчитывается при
  повторном ожидании. `findPending`/`listPending` не отдают просроченные
  ожидания — approve после дедлайна получает «нет ожидания».
- `ExpiredApprovalsService` (интервал `HITL_EXPIRY_CHECK_INTERVAL_MS`,
  default 5 мин, первый тик сразу) находит просроченные: отменяет каждый
  escrow-hold (best-effort), удаляет checkpoint треда через checkpointer,
  переводит запись в `expired` и логирует
  `hitl.approval_expired {conversationId,userId,reason,holds}`. Граф не
  возобновляется; ошибка одной записи не останавливает остальные.
- `GET /api/v1/chat/pending` отдаёт `expiresAt` (ISO, поле отсутствует, если
  TTL нет); AI-Офис показывает таймер «Осталось N ч» и перезапрашивает
  список после истечения.

**Остаток:** до ближайшего тика job'а (≤5 мин) просроченное ожидание уже не
активно, но hold ещё не разморожен — окно ограничено интервалом проверки.

### KI-034 — Checkpoint'ы без ретенции

**Влияние:** Каждый шаг графа сохраняется в `GraphCheckpoint`/
`GraphCheckpointWrite`; при удалении диалога или после завершённых тредов
строки накапливались — вызывающего кода для `deleteThread`/ретенции не было.

**Исправлено (Sprint 16):** `CheckpointRetentionService`
(`CHECKPOINT_RETENTION_DAYS`, default 30; интервал
`CHECKPOINT_RETENTION_CHECK_INTERVAL_MS`, default 6 ч, первый тик сразу):

- находит диалоги с `updatedAt` старше cutoff, у которых нет активного
  `PendingApproval` (батч 200);
- находит orphan-треды: `threadId` из `GraphCheckpoint`, для которых нет
  `Conversation` (например, диалог удалён);
- удаляет `GraphCheckpointWrite` и `GraphCheckpoint` по этим тредам,
  логирует `checkpoint.retention_cleaned {threads,checkpoints,writes}`;
- активные диалоги и треды с ожидающим решением не трогаются.

**Остаток:** resolved-записи `PendingApproval` (approved/rejected/expired)
пока не чистятся — история растёт медленно (KI-043); retention выполняется
в каждом процессе API, операция идемпотентна (deleteMany по списку тредов).

### KI-035 — Offsite-бэкапы без object-lock и KMS

**Влияние:** Offsite-выгрузка использует внешний `rclone` на хосте и один
S3-совместимый bucket. Скрипт не настраивает versioning/object-lock, не
шифрует дампы на клиенте и не проверяет checksum отдельно от rclone. При
компрометации access key или ошибочном удалении в bucket копии можно
потерять; retention удаляет объекты только по возрасту, без keep-min.
Секреты `BACKUP_S3_*` хранятся в `.env` на хосте.

**Обход:** Включить на bucket versioning и object-lock/lifecycle, выдать
ключу минимальные права (PutObject/List/Delete только по префиксу), хранить
`.env` с правами `600`, настроить алерт на код возврата `backup-db.sh != 0`.
Проверять восстановление через `restore-drill.sh`.

**План:** Добавить server-side encryption/KMS и опциональное клиентское
шифрование, immutable-политику и keep-min для offsite, проверку checksum
после загрузки и выгрузку в два независимых bucket'а/региона.

### KI-036 — Restore-drill на том же PostgreSQL

**Влияние:** `restore-drill.sh` восстанавливает дамп в временную БД на том же
инстансе PostgreSQL, который обслуживает production. Это создаёт нагрузку на
диск/CPU и требует роли с `CREATEDB`; при аварии самого инстанса drill
невозможен. Проверка ограничена наличием и доступностью таблиц `User` и
`LedgerEntry` (count-запросы), а не сверкой контрольных сумм/бизнес-инвариантов.
Уведомление об ошибке — только код возврата и лог cron, без встроенного
алертинга.

**Обход:** Запускать drill в окно низкой нагрузки, использовать отдельный
результат в логе и алерт на ненулевой код; периодически проверять
восстановление на отдельном стенде. Не считать успешный count-запрос полной
гарантией целостности Ledger.

**План:** Выполнять drill на отдельном PostgreSQL/эпhemeral-инстансе, добавить
проверку инвариантов Ledger (суммы, append-only-триггеры), доставку
результата в мониторинг и отчёт с длительностью/размером восстановления.

### KI-037 — `db-migrate` только для Compose

**Влияние:** `db-migrate` реализован как one-shot сервис Compose. В
Kubernetes ему нужен отдельный Job с тем же образом и `prisma migrate deploy`;
compose-файл этого не создаёт. При одновременном запуске нескольких
`docker compose up` (например, из двух CI-джоб) оба `db-migrate` могут
попытаться применить миграции; Prisma использует advisory locks, но
предсказуемость зависит от версии. Нет отдельной метрики/алерта на зависшую
или упавшую миграцию.

**Обход:** Запускать миграции одним оркестратором (Compose/Job) до старта
реплик; не выполнять `compose up` параллельно из разных окружений; смотреть
`docker compose logs db-migrate` и статус `Exited (0)`.

**План:** Добавить Kubernetes Job/Helm-хук, распределённую блокировку
миграций и метрику `db_migrate_duration_seconds`/алерт на неуспешный запуск.

### KI-038 — OTel Collector без durable backend

**Влияние:** Коллектор принимает OTLP и выводит спаны через `debug` exporter
в stdout. Нет постоянного хранилища, sampling-политики, retention, TLS и
аутентификации приёмника; порты опубликованы только на `127.0.0.1`, поэтому
удалённый сбор невозможен без отдельного решения. Спаны `gen_ai.usage`
создаются после получения ответа и фиксируют итоговые атрибуты/стоимость;
длительность запроса видна по HTTP/Nest-спанам, а не по usage-спану.

**Обход:** Для локальной диагностики использовать
`docker compose logs -f otel-collector`; для production подключить
collector с persistent backend (Tempo/Jaeger/OTLP SaaS) и sampling осознанно.
Не публиковать 4317/4318 наружу.

**План:** Добавить OTLP backend с retention и sampling, TLS/mTLS и
аутентификацию, корреляцию `trace_id` с JSON-логами, а также измерение
latency непосредственно вокруг вызова провайдера.

### KI-039 — Sentry только для backend и с эвристическим PII-фильтром

**Влияние:** Sentry инициализируется только при `SENTRY_DSN` и ловит
необработанные исключения/5xx backend. Frontend Sentry, performance tracing
и интеграция с алертингом не настроены. PII-фильтр отключает сбор
headers/bodies/cookies/query/user/genAI-контента и маскирует известные
форматы токенов, но это regex-эвристика: нестандартный секрет в тексте
исключения может остаться. DSN хранится в `.env`.

**Обход:** Не передавать секреты в сообщения исключений; проверять события
Sentry после релиза; использовать отдельный проект/ключ для staging и
production. Считать фильтр defense-in-depth, а не гарантией отсутствия PII.

**План:** Добавить frontend Sentry с теми же фильтрами, структурированные
коды ошибок вместо свободного текста, тесты на новые форматы токенов и
алерты по частоте 5xx/новым issue.

### KI-040 — Стоимость LLM считается по единому тарифу

**Влияние:** `llm_cost_total` и списание используют
`LLM_COST_PER_1K_TOKENS` (0.01 ₽ за 1000 токенов) для всех моделей и
провайдеров. Реальные тарифы GigaChat/OpenAI/Yandex различаются, поэтому
метрика и Ledger могут расходиться с фактическим счётом. Лейбл `tenant_id`
содержит userId и растёт с числом пользователей — возможна высокая
кардинальность Prometheus; серия появляется только после первого вызова.

**Обход:** Использовать метрику для относительного сравнения tenant'ов, а
не как биллинг; деньги сверять по Ledger/провайдеру. Для контроля
кардинальности ограничить retention/агрегацию в Prometheus.

**План:** Ввести тарифы по модели/провайдеру (таблица или конфиг), учитывать
input/output отдельно, добавить per-model стоимость и метрику расхождения
с фактическим счётом; при необходимости агрегировать tenant'ов.

### KI-041 — Control Plane UI не редактировал поля LLM Router

**Влияние:** Fallback-цепочка и бюджеты LLM Router v2 работали, но Control
Plane UI (`apps/web/src/lib/admin.ts`) не показывал и не редактировал новые
поля `taskType`/`dailyCostLimit`: задавать их можно было только через
admin-API. Кроме того, ответ списка маршрутов не валидировался Zod.

**Исправлено (Sprint 17):**

- В форму создания и редактирования маршрута добавлены `taskType` (select
  `chat`/`analysis`/`embeddings`, значения совпадают с `LLM_TASK_TYPES` API) и
  `dailyCostLimit` (необязательное неотрицательное число в ₽/сутки).
- В таблице маршрутов появился столбец «Лимит: 500 ₽/день» (для маршрута без
  лимита — «Без лимита»), тип задачи показан бейджем рядом с названием,
  у каждой строки есть кнопка «Изменить» (`PATCH /admin/llm-routes/:id`).
- `LlmRoute` описан Zod-схемой (`llmRouteSchema`), ответы `GET`, `POST` и
  `PATCH /admin/llm-routes` валидируются до попадания в UI; новые поля
  опциональны для совместимости со старым API.
- Пустое поле `dailyCostLimit` при создании означает «без лимита», при
  редактировании — «оставить текущий лимит»: контракт `UpdateLlmRouteDto` не
  описывает `null`, поэтому снять лимит через UI пока нельзя.

**Обход (до Sprint 17):** настраивать маршруты через admin-API. Сейчас UI
покрывает создание, редактирование полей и просмотр лимита.

**Остаток:** A/B-тестирование и распределение трафика не реализованы
(KI-009). 502 для одиночного маршрута/env-fallback исправлен в рамках
KI-044.

### KI-042 — Остатки Egress hardening

**Влияние:** Egress allowlist работает на уровне IP:port: разрешённый IP можно
использовать с любым `Host`/SNI (TLS-прокси нет). Остаются DNS
rebinding/SSRF (разрешённый домен может резолвиться во внутренний/metadata-IP
— нет проверки диапазонов), ротация IP у CDN требует перезапуска контейнера,
worker и entrypoint резолвят независимо (при ротации может разойтись
`ExtraHosts` и iptables-ACCEPT), ExtraHosts поддерживает только IPv4
(AAAA-only домены пропускаются с логом).

**Обход:** Объявлять в `egress_allowlist` только собственные API-домены без
публичных CDN; держать bridge-сеть без доступа к внутренним сервисам;
проверять логи worker (`unresolved`/`ipv6Only`) при проблемах с доменом.

**План:** TLS egress-прокси с allowlist по SNI/Host (и DNS-pinning с
range-денлистом), единый резолв IP для hosts и iptables, поддержка IPv6 в
ExtraHosts при появлении в Docker.

### KI-043 — Rows PendingApproval и кеш tools/list

**Влияние:** `PendingApproval` хранит resolved-записи (approved/rejected/
expired) бессрочно — таблица растёт медленно, но retention для неё не
настроен. MCP discovery кеширует `tools/list` на время SSE-сессии: если
сервер обновил набор инструментов, API увидит изменения только после
переподключения (перезапуска) MCP-клиента.

**Обход:** Периодическая очистка resolved-записей SQL-запросом по
`createdAt`; переподключение MCP-сервера/перезапуск API после обновления его
инструментов.

**План:** Ретенция `PendingApproval` (например, 30 дней) в том же job'е, что
и checkpoint'ы; TTL/ручное обновление кеша discovery (`tools/list` при
открытии новой сессии уже перечитывается).

### KI-044 — 502 только для реальной fallback-цепочки

**Влияние:** `errors.llm_unavailable` (502) возвращается, только когда у
маршрута была реальная цепочка (`routes.length > 1`) и все её маршруты упали
с retriable-ошибкой. При одиночном маршруте или env-fallback исходная ошибка
провайдера пробрасывается клиенту как раньше (обратная совместимость
тестов/поведения). UI маппит код `errors.llm_unavailable` в понятное
сообщение, но при одиночном маршруте такого кода нет.

**Обход:** Считать ошибки провайдера при одиночном маршруте диагностическими;
для единообразного 502 настроить fallback-цепочку из двух и более маршрутов.

**План:** Возвращать 502 `errors.llm_unavailable` и для одиночного маршрута
(с обновлением тестов `llm.service.spec.ts`), не менять поведение
env-fallback без отдельного решения.

**Исправлено (Sprint 17):** В `LlmInferenceService.stream` (llm-worker) 502
`errors.llm_unavailable` возвращается для любой retriable-ошибки последней
попытки: одиночный маршрут, env-fallback и исчерпанная fallback-цепочка.
Резерв дневного бюджета по-прежнему возвращается ровно один раз. Ошибки
400/401/403 не маскируются — они означают проблему конфигурации, а не
недоступность провайдера. Покрыто тестами
`apps/llm-worker/src/llm/inference.service.spec.ts` (одиночный маршрут,
env-fallback, 400, цепочка из двух маршрутов).

### KI-045 — Внутренний токен API ↔ llm-worker

**Влияние:** Внутренние эндпоинты `/api/v1/internal/agent/*` и
`/v1/graphs/*` защищены общим `INTERNAL_API_TOKEN`. Если переменная пуста
(локальная разработка), проверка отключена и запросы принимаются от любого
источника, доступного по сети. mTLS, подписи запросов и Kubernetes
NetworkPolicy не используются; компрометация одного контейнера даёт доступ к
внутреннему API другого.

**Обход:** В production обязательно задавать случайный
`INTERNAL_API_TOKEN`, не публиковать порт `llm-worker` наружу и держать
сервисы в отдельной bridge-сети без доступа к PostgreSQL/Redis извне.

**План:** mTLS или SPIFFE-идентичность для внутреннего трафика, отдельные
токены на направление, NetworkPolicy/Compose-сеть только для api ↔ worker.

### KI-046 — JSON Schema ↔ Zod подмножество

**Влияние:** API строит JSON Schema инструментов через `z.toJSONSchema`, а
worker конвертирует её обратно в Zod (`jsonSchemaToZod`). Поддерживаются
объекты, строки, числа, булевы значения, массивы, enum, `anyOf`/`oneOf` и
`additionalProperties`. Сложные конструкции (`$ref`, `allOf`, условные
схемы, tuple) превращаются в `z.unknown()`: модель всё равно увидит
параметры, но локальная валидация в worker'е будет мягче. Окончательная
валидация остаётся в API.

**Обход:** Держать схемы инструментов простыми (плоские объекты и массивы
примитивов), как в текущих манифестах; проверять новые инструменты
unit-тестом конвертера.

**План:** Использовать `z.fromJSONSchema` из Zod 4 после стабилизации API
или генерировать Zod-схемы из общего пакета, убрав дублирование.

### KI-047 — Уведомления об ожидающем подтверждении

**Влияние:** BullMQ-очередь `agent-notifications` принимает job
`approval-pending`, но обработчик только пишет структурированный лог
`hitl.approval_notification`. Email/push/webhook не отправляются, подтверждения
доставки и dead-letter-мониторинга нет. Ретраи BullMQ защищают от временных
сбоев обработчика, но не гарантируют внешнюю доставку.

**Обход:** Следить за логом `hitl.approval_prepared`/`hitl.approval_notification`;
UI получает ожидания через `GET /api/v1/chat/pending`.

**План:** Подключить канал уведомлений (email/webhook/Telegram), хранить
статус доставки и добавить алерт на рост failed jobs.

### KI-048 — Синхронный транспорт worker → API

**Влияние:** На каждый LLM-вызов worker делает HTTP-запрос резерва бюджета,
на каждый tool-call — запрос выполнения, на каждый checkpoint — get/put/writes.
API недоступен → граф падает с 502, in-flight состояние может остаться в
последней сохранённой точке. Нет circuit breaker, таймаутов на отдельные
вызовы (кроме общего 30 с в `InternalApiClient`) и батчинга checkpoint-writes.

**Обход:** Держать API и worker в одной compose-сети, мониторить 5xx/таймауты,
перезапускать worker после восстановления API; resume использует последний
checkpoint.

**План:** Retry с backoff и circuit breaker для внутреннего клиента,
батчинг writes, асинхронная очередь для некритичных событий (уведомления,
телеметрия).

### KI-049 — E2E не покрывает tool-calls и HITL через worker

**Влияние:** Playwright E2E поднимает стек с пустыми `LLM_BASE_URL`/
`LLM_MODEL`, поэтому worker отвечает эхо-заглушкой и не вызывает инструменты,
не создаёт HITL-ожидания и не проходит ветку `approvals`. Контракт
worker → API (`tools/execute`, `approvals/prepare|resolve`, budget,
checkpoints) проверяется unit-тестами и ручным stub-сервером, но не в CI.

**Обход:** При изменении контрактов запускать unit-тесты
`apps/llm-worker/src/**` и `apps/api/src/agent/**`; ручная проверка —
`docker compose up` с реальным LLM и навыком, требующим подтверждения.

**План:** Добавить контрактный тест с mock LLM, возвращающим `tool_calls`, и
E2E-сценарий approve/reject с проверкой Ledger и `PendingApproval`.

### KI-050 — Возврат из Google OAuth и реальные проверки интеграций

**Влияние:** UI раздела «Интеграции» (`apps/web/src/lib/integrations.ts`)
рассчитывал на бэкенд-контракт, а Google callback отвечал JSON и не возвращал
браузер в настройки. Реальные Telegram `getMe` и Google OAuth нельзя было
проверить без ключей окружения.

**Исправлено (Sprint 18):**

- Бэкенд реализует контракт UI: `GET /integrations` (сводный статус),
  `POST/DELETE /integrations/telegram` (проверка `getMe`, шифрованное
  хранение токена бота), `GET /integrations/google/authorization-url`
  (alias `authorize`), `GET /integrations/google/status`,
  `DELETE /integrations/google` и `POST /integrations/google/exchange`.
- `GET /integrations/google/callback` при заданном
  `GOOGLE_OAUTH_SUCCESS_REDIRECT` отвечает 302 на
  `<redirect>?integration=google&status=success|error`, иначе — JSON
  `{ connected, scope, expiresAt }` (для curl/диагностики).
- Контракт, статусы, ошибки и шифрование покрыты unit-тестами (nock для
  Telegram/Google), OAuth refresh проверен на mock token-endpoint.
- **Остаток:** реальные Telegram-бот и Google OAuth client проверяются в
  staging после выдачи ключей; локально используются тестовые ключи из
  `.env` и nock.

### KI-051 — Telegram webhook: replay и IP-allowlist

**Влияние:** Публичный `/api/v1/webhooks/telegram` защищён секретом
`X-Telegram-Bot-Api-Secret-Token` и rate limit на IP. Любой, кто узнал
секрет, может присылать update с произвольным `update_id`; повторные и
задержанные доставки не дедуплицируются, IP-сети Telegram на edge не
ограничены. Rate limit считает по `X-Forwarded-For`, поэтому доверенный
прокси обязателен.

**Обход:** Хранить секрет только в `.env`/Docker secret, ротировать через
`setWebhook`; не публиковать API напрямую; мониторить 401/429.

**План:** Хранить обработанные `update_id` в Redis с TTL и отбрасывать
дубликаты; добавить allowlist сетей Telegram и лимит размера body на Caddy.

### KI-052 — Egress: прикладной allowlist, не сетевая изоляция

**Влияние:** `provider-http` проверяет `OUTBOUND_ALLOWLIST` для Telegram,
Google OAuth/API и Google Docs/Sheets/Calendar; worker проверяет URL
LLM-маршрутов. Это защищает от случайного или подменённого URL, но не
является NetworkPolicy: скомпрометированный процесс может делать соединения
в обход кода. Часть существующих клиентов API (embeddings, MCP, YooKassa)
не проходит через единый guard.

**Обход:** В production задавать allowlist и не давать контейнерам лишних
сетевых маршрутов; выносить egress в прокси/NetworkPolicy.

**План:** Единый egress-прокси с allowlist по SNI/Host, перевести все
HTTP-клиенты API на общий guard, добавить deny-all NetworkPolicy.

### KI-053 — Ротация ключа шифрования OAuth-токенов

**Влияние:** Токены шифруются AES-256-GCM ключом `TOKEN_ENCRYPTION_KEY` из
env/Docker secret. Envelope не содержит `keyId`, поэтому после смены ключа
старые refresh-токены станут нечитаемыми. Облачный KMS и автоматическая
ротация не подключены.

**Обход:** Хранить ключ в менеджере секретов, делать бэкап ключа вместе с
БД; при ротации сначала расшифровать и перешифровать все `GoogleCredential`.

**План:** Добавить `keyId` в envelope и колонку `keyId`, поддержку
previous-key при чтении, миграционный re-encrypt и провайдер Yandex
KMS/Vault.

### KI-054 — Отзыв Google-токенов при disconnect

**Влияние:** `GoogleOAuthService.disconnect` удаляет строку
`GoogleCredential`, но не вызывает `https://oauth2.googleapis.com/revoke`.
Refresh-token остаётся действительным на стороне Google, пока не истечёт
или не будет отозван вручную.

**Обход:** При компрометации отзывать доступ в Google Account →
Security → Third-party access.

**План:** Вызывать revoke endpoint перед удалением локальной записи;
логировать результат best-effort.

### KI-055 — Внешние API Midjourney, Ozon и Wildberries остаются Mock

**Влияние:** Историческая часть KI-012: навыки `midjourney-api`,
`ozon-seller` и `wb-seller` по-прежнему возвращали демонстрационные данные
(`generate_image` — placeholder-URL, финансовые инструменты — фиктивные
суммы).

**Исправлено (Sprint 19):**

- `generate_image` реально вызывает TTAPI (единственный разрешённый
  провайдер): `POST https://api.ttapi.io/midjourney/v1/imagine` с заголовком
  `TT-API-KEY` и `{prompt, mode:"fast"}` → `jobId`; поллинг
  `GET https://api.ttapi.io/midjourney/v1/fetch?jobId=...` до `completed` →
  `imageUrl`. 429/5xx повторяются с экспоненциальным backoff через
  `provider-http`, ошибки маппятся в
  `errors.provider_rate_limited`/`provider_unavailable`, без ключа — 503
  `errors.provider_not_configured`. Базовый URL/пути зафиксированы в коде;
  GoAPI/UseAPI/Discord-обёртки не используются. Pay-per-Call списывается
  после успешной генерации.
- Ozon/WB финансовые данные идут через реальные MCP-серверы (см. KI-015);
  `ozon_mcp_call`/`wb_mcp_call` продолжают работать как раньше.
- Тесты: `midjourney.service.spec.ts` (nock: imagine → polling → URL,
  429/5xx retry, failed/timeout, нет ключа),
  `agent-tools.service.spec.ts` (списание после генерации).

**Остаток:** сам Midjourney доступен только через сторонний прокси
(KI-059); Ozon/WB MCP требуют ключей продавца (KI-011/057).

### KI-056 — Telegram webhook только для системного бота

**Влияние:** `POST /api/v1/webhooks/telegram` обслуживает один системный бот
(`TELEGRAM_BOT_TOKEN`). Бот, подключённый пользователем через
`POST /integrations/telegram`, сохраняется зашифрованным и используется
только для исходящих `sendMessage`; входящие обновления для него не
принимаются (у Telegram один webhook на бота, а регистрация per-user
webhook'ов не реализована).

**Обход:** Для входящих сообщений использовать системного бота и привязку
чата (`POST /integrations/telegram/link`); персонального бота — только для
отправки от имени пользователя.

**План:** Поддержать несколько ботов: маршрут
`/webhooks/telegram/:botId`, проверка секрета per-bot, регистрация
`setWebhook` для каждого подключённого бота; хранить `webhookSecret` в
`TelegramBot`.

### KI-057 — MCP-healthcheck не проверяет scope и срок ключей

**Влияние:** `infra/mcp/healthcheck.py` проверяет, что env-переменные
`OZON_CLIENT_ID`/`OZON_API_KEY` или `WB_API_TOKEN` непустые, и что
`/api/health` отвечает 200. Он не делает запрос к Seller API, поэтому
просроченный токен, неверный scope или отозванный ключ могут оставить
контейнер healthy. Ключи, добавленные через web-панель MCP, не видны
healthcheck'у.

**Обход:** Запускать `scripts/test-integrations.sh` после смены ключей и
проверять `/diagnostics`/`/shops` соответствующего MCP-сервера.

**План:** Добавить в healthcheck лёгкий authenticated-запрос к Ozon/WB
(например, список складов/заказов) с кэшем и отдельным таймаутом; учитывать
ключи, сохранённые web-панелью.

### KI-058 — Тестовые endpoint'ы Ozon/WB версионно-зависимы

**Влияние:** `scripts/test-integrations.sh` по умолчанию вызывает
`POST /v1/product/import/prices` (Ozon Seller), `GET /ping` на
`discounts-prices-api.wildberries.ru` (WB Pricing) и
`GET /midjourney/v1/fetch?jobId=test` (TTAPI). При изменении версии/пути
API скрипт даст ложный FAIL, хотя ключи валидны. Минимальные права токена
WB могут не покрывать Pricing API.

**Обход:** Переопределять `OZON_API_TEST_PATH`, `WB_API_TEST_PATH`,
`MIDJOURNEY_TEST_PATH` и `*_API_BASE_URL`/`WB_PRICING_API_BASE_URL` в
`.env`; сверять актуальный путь в кабинете провайдера.

**План:** Поддержать несколько известных probe-путей с fallback и
конфигурируемый read-only endpoint; добавить mock-режим для CI.

### KI-059 — Midjourney только через сторонний прокси

**Влияние:** У Midjourney нет официального публичного API. Инфраструктура
использует TTAPI (`https://api.ttapi.io`) как выбранный прокси; GoAPI и
UseAPI закрылись в июне 2026, APIFRAME — возможный fallback, но требует
отдельного домена в allowlist. Контракт, лимиты и SLA зависят от
провайдера; домен `api.ttapi.io` зафиксирован в `OUTBOUND_ALLOWLIST`.

**Обход:** Использовать TTAPI, задавать `MIDJOURNEY_BASE_URL` и
`MIDJOURNEY_TEST_PATH`, проверять `scripts/test-integrations.sh
--midjourney`; хранить ключ только в `.env`/менеджере секретов.

**План:** Абстракция Midjourney-клиента с адаптерами TTAPI/APIFRAME,
polling задач и обработкой `202/queued`, лимиты расходов и метрики ошибок.

### KI-060 — UI Sprint 19 без контроллеров финансового дашборда

**Влияние:** Страница `/app/finance` ожидала `GET /finance/overview` с
fallback на `/finance/unit-economics`, `/finance/profit-leaks`,
`/finance/fraud-shield`, но в API этих маршрутов не было: дашборд показывал
`errors.notFound`, а финансовые результаты существовали только в ответах
tool call'ов агента.

**Исправлено (Sprint 19):** Добавлен `FinanceController`
(`apps/api/src/finance/`):

- `GET /api/v1/finance/overview` — агрегат последних `unit-economics`,
  `profit-leak-detector` и `fraud-shield-audit` текущего пользователя
  (`currency`, `period`, `unitEconomics[]`, `profitLeaks[]`, `fraudShield`,
  `dataAvailable`, `reason`, `updatedAt`);
- `GET /api/v1/finance/unit-economics` — `{ items[] }` +
  фильтры `sku`, `marketplace`;
- `GET /api/v1/finance/profit-leaks` — `{ items[] }` + фильтр `marketplace`;
- `GET /api/v1/finance/fraud-shield` — последний аудит (форма
  `FraudAuditResult`) + фильтр `campaignId`.

Контракт — `apps/api/src/finance/finance-contracts.ts`: Zod-схемы повторяют
`apps/web/src/lib/finance.ts` (это проверяет
`finance.controller.spec.ts`, где лежит зеркало UI-схемы: при расхождении
тест падает). Лишние поля инструментов (`spend`, `adSpend`, `deductions`,
`antifraudRecords`) сохраняются через `.passthrough()` — UI их игнорирует.

Данные берутся из `FinanceSnapshotStore`, куда `AgentToolsService` пишет
**только успешные** результаты `FinanceToolsService` (реальные MCP-вызовы
Ozon/WB) после списания BAL. REST ничего не пересчитывает: иначе GET обходил
бы Pay-per-Call/Pay-per-Outcome и создавал бы побочные эффекты. Хранилище —
Redis (`REDIS_URL`, TTL `FINANCE_SNAPSHOT_TTL_SECONDS`, по умолчанию 7
суток), резерв — память процесса (без Redis/после рестарта дашборд честно
отдаёт `dataAvailable:false`).

Если расчётов ещё не было, ответ — `200` с `dataAvailable:false` и причиной
(«запустите инструмент в чате»), а не `404`, пустой массив без признака или
вымышленные суммы. Некорректные query-параметры — `400`
`errors.invalid_request`; `userId` берётся только из JWT, данные разных
пользователей не смешиваются.

**Остаток:** подключение ключей из UI закрыто в KI-063.

### KI-061 — Ozon: комиссия и логистика распределяются по выручке SKU

**Влияние:** Ozon в `/v1/finance/accrual/by-day` не привязывает комиссию,
логистику и хранение к конкретному SKU: в начислениях есть категории и
`type_id` услуг, но не `sku`. `unit-economics` распределяет расходы
пропорционально выручке SKU из `ozon_analytics` за период и явно пишет это
в `assumptions`. Для SKU с нетипичной структурой расходов (крупногабарит,
много возвратов) оценка может отличаться от фактического отчёта Ozon.

**Обход:** Для точной сверки использовать отчёт о реализации Ozon и
передавать известную себестоимость (`cost`); не принимать решение по цене
только на основе распределённых расходов.

**План:** Использовать отчёт о реализации Ozon (когда доступен через MCP)
или запрашивать у MCP сервер `ozon_finance_transactions` с детализацией до
отправления и сопоставлять `posting_number` → SKU.

### KI-062 — ERID/UTM не отдаются MCP-серверами Ozon/WB

**Влияние:** `fraud-shield-audit` проверяет наличие ERID/UTM в сырых данных
рекламной кампании (`ozon_ad_campaigns`, `wb_advert_list`) и расходах, но
MCP-серверы Ozon/WB не возвращают эти поля отдельными атрибутами. Поэтому
аудит по умолчанию показывает `missing_erid`/`missing_utm` и требует ручной
проверки в рекламном кабинете; юридически значимой проверкой маркировки он
не является.

**Обход:** Проверять ERID/UTM в кабинетах Ozon/WB или через официальные
административные API; результаты аудита использовать как сигнал, а не
доказательство.

**План:** Добавить коннектор к рекламным API с полями маркировки/UTM либо
импорт доказательного пакета; тогда `eridPresent`/`utmPresent` станут
достоверными.

### KI-063 — UI Sprint 19 без контроллеров подключения ключей

**Влияние:** Карточки интеграций ждали
`POST/DELETE /integrations/{ozon,wildberries,midjourney}` с телами
`{ clientId, apiKey }` (Ozon), `{ apiToken }` (WB), `{ apiKey }`
(Midjourney TT-API-KEY) и поля `ozon`/`wildberries`/`midjourney` в
`GET /integrations`. В API этих маршрутов не было: ключи задавались только
через env (`OZON_CLIENT_ID`/`OZON_API_KEY`, `WB_API_TOKEN`,
`MIDJOURNEY_API_KEY`), UI показывал `disconnected`, а подключение из
интерфейса возвращало 404.

**Исправлено (Sprint 19):** Ключи хранятся per-user в
`ProviderCredential` (`apps/api/prisma/schema.prisma`, миграция
`20261113203000_add_provider_credentials`):

- `secret` — envelope `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM,
  `TokenCipherService`/`TOKEN_ENCRYPTION_KEY`); в БД нет ни Client ID, ни
  токенов/ключей открытым текстом. `metadata` — только неконфиденциальные
  поля (срок действия токена WB);
- `POST/DELETE /api/v1/integrations/{ozon|wildberries|midjourney}`,
  `GET /api/v1/integrations` отдаёт `ozon`/`wildberries`/`midjourney` со
  статусами `active`/`disconnected`/`error`, `clientId` (Ozon),
  `tokenExpiresAt` (WB, +180 дней от подключения) и `source`
  (`user`/`env` — работают личные ключи или системные);
- Zod-валидация тел (`.strict()`), `401` без JWT, `400`
  `errors.invalid_request` на неверное тело, `503`
  `errors.provider_not_configured` без `TOKEN_ENCRYPTION_KEY`;
- инструменты читают ключи по `userId`: `MarketplaceMcpService` (Ozon/WB) и
  `MidjourneyService` (TTAPI) — БД приоритетнее env, env остаётся fallback
  для системных ботов; при битом/нерасшифровываемом envelope инструмент
  логирует `integration.provider_decrypt_failed` и падает обратно на env;
- тесты: `provider-keys.service.spec.ts` (15), `integrations.controller.spec.ts`
  (11), `midjourney.service.spec.ts` (+3 про ключ пользователя),
  `marketplace-mcp.service.spec.ts` (6), `agent-tools.service.spec.ts`
  (+2 про передачу `userId`).

**Остаток:** сами MCP-контейнеры Ozon/WB по-прежнему аутентифицируются
своими env-ключами — см. KI-064.

### KI-064 — Личные ключи Ozon/WB не доходят до MCP-серверов

**Влияние:** Ключи Ozon/WB, сохранённые пользователем, используются как
источник истины для подключения/статуса и аудита, но MCP-серверы
(`ozon-mcp-server`, `wb-mcp-server`) читают `OZON_CLIENT_ID`/
`OZON_API_KEY`/`WB_API_TOKEN` из своего окружения при старте (один набор на
контейнер) и не принимают креды в аргументах инструмента. Поэтому при
мульти-тенантном сценарии запросы разных продавцов будут выполняться под
ключами контейнера: без env-ключей вызов вернёт
`errors.marketplace_unavailable` с пояснением (KI-064), а с ними — пойдёт
под системными ключами. Midjourney (TTAPI) вызываетcя напрямую из API,
поэтому там личный ключ пользователя используется полностью.

**Обход:** Для одного продавца — задавать ключи и в UI (для статуса), и в
env MCP-контейнера (для фактических запросов); ключи пользователя
использовать как индикатор подключения.

**План:** Передавать креды в MCP-сервер per-request (расширение
`ozon-mcp-server`/`wb-mcp-server` заголовками `X-Ozon-Client-Id`/
`X-Ozon-Api-Key` или запуск отдельного MCP-инстанса на арендатора), затем
`McpClient` пробросит ключи из `ProviderCredential`. Требует изменений вне
этого репозитория (PyPI-пакеты MCP-серверов).

### KI-065 — UI загрузки документов без маршрута `POST /documents`

**Влияние:** В чате есть полноценная загрузка PDF и сканов: drag-and-drop,
выбор файла, Zod-валидация до отправки (тип, пустой файл, лимит 15 МБ),
прогресс, отмена и «отправить извлечённый текст в чат». Но в API Sprint 19
такого маршрута нет: `POST /api/v1/documents` отвечает 404. До появления
эндпоинта панель показывает понятное «загрузка документов пока недоступна»
(по коду 404/405/501), а не общую ошибку сети. Клиентских OCR/PDF-библиотек
в bundle нет намеренно: парсинг — задача бэкенда, дублировать его в браузере
означает второй, расходящийся движок.

**Контракт UI** — `apps/web/src/lib/documents.ts`, путь задан константой
`DOCUMENTS_ENDPOINT`. Запрос: `multipart/form-data`, поле `file`; PDF, PNG,
JPEG или WebP до 15 МБ. Ответ:

```json
{
  "id": "doc_1",
  "filename": "resume.pdf",
  "mimeType": "application/pdf",
  "size": 1024,
  "kind": "pdf",
  "text": "…",
  "tables": [
    { "title": "Опыт", "columns": ["Компания"], "rows": [["Яндекс"]] }
  ],
  "warnings": [],
  "createdAt": "2026-11-14T10:00:00.000Z"
}
```

Схема терпимая к внутреннему формату парсера: `text` можно не присылать,
если есть `pages[].text`; `tables[].columns` и `tables[].page`
необязательны (без подписей UI нумерует колонки); `kind` выводится из
`mimeType`; `warnings` и `createdAt` необязательны. Ошибки различаются:
`404/405/501` — маршрута нет; `413`/`errors.document_too_large` — размер;
`415`/`errors.unsupported_document_type` — тип; остальное — «не удалось».

**План:** Реализовать маршрут в API (`FileInterceptor('file')`, лимит
15 МБ, Zod-валидация MIME) поверх `apps/api/src/agent/documents`
(`pdf-text`, `ocr-smart-engine`); при другом пути изменить одну константу
`DOCUMENTS_ENDPOINT` в UI. После появления эндпоинта — закрыть KI-065 и
добавить E2E загрузки.

**Исправлено (Sprint 20):** маршрут `POST /api/v1/documents` реализован в
`apps/api/src/documents/`: `FileInterceptor('file')` с лимитом 15 МБ,
JWT-авторизация, rate limit 30/мин, `DocumentsService` разбирает PDF через
`agent/documents/pdf-text.ts`, а сканы — через `OcrSmartEngineService`.
Ответ совпадает с контрактом UI (`text` + `tables[{page, rows}]`),
`UploadErrorFilter` отдаёт `413 errors.document_too_large` и
`415 errors.unsupported_document_type` в едином JSON. E2E-тест загрузки
остаётся в KI-049 (общий E2E на реальные tool-calls).

### KI-066 — Разметка результата агента (таблицы, код, резюме) не закреплена контрактом

**Влияние:** UI сам разбирает ответ агента (`lib/message-blocks.ts`):
pipe-таблицы рендерятся `<table>`, fence с языком — блоком кода, JSON
`resume-screener` в fence `json` — карточками навыков и опыта. Это
договорённость с агентами, а не серверный контракт: если `resume-screener`
вернёт другую структуру (или обернёт её глубже `candidate`/`resume`/`data`),
чат покажет JSON блоком кода, а не карточками. Ошибки не возникает —
деградация только визуальная.

**Обход:** Промпты навыков возвращают результат текстом с pipe-таблицами и
JSON-блоком на языке `json`; незнакомые поля JSON игнорируются, карточки
строятся по `name`, `title`, `summary`, `score`, `verdict`, `skills`,
`experience`, `education`.

**План:** Описать формат результата в манифесте навыка/промпте
`resume-screener` и в спецификации инструментов; после реального
`resume-screener` (Sprint 20, KI-014) добавить E2E с настоящим tool-call
(связано с KI-049). Схема карточек: `apps/web/src/lib/resume.ts`.

**Sprint 20:** `screen_resume` теперь отдаёт верхний уровень по этой схеме
(`name`, `title`, `summary`, `score`, `verdict`, `skills`, `experience`,
`education`), детали разбора — в `analysis`; ключей `candidate`/`resume`/`data`
в ответе нет. Для `resume-screener` риск снят, конвенция pipe-таблиц и fence
для остальных инструментов остаётся.

### KI-067 — HITL-карточка узнаёт инструмент только из `GET /chat/pending`

**Влияние:** Событие `office_event` сообщает статус `waiting_approval` и
причину (`approval`/`payment`), но не список инструментов. Поэтому кнопка
«Одобрить публикацию» для `dzen-article` появляется после того, как UI
подтянет `GET /api/v1/chat/pending` (инвалидация кэша по событию). Пока
REST не ответил (или недоступен), карточка HITL показывается с нейтральной
подписью «Одобрить действие» — само подтверждение (`approve_action`)
работает, страдает только текст кнопки.

**Обход:** Карточка не блокирует подтверждение: `approve_action` не зависит
от списка инструментов, а Office показывает «Одобрить публикацию» в списке
ожиданий, где инструменты уже есть.

**План:** Добавить `tools` (или `action`) в payload `office_event` на
бэкенде; тогда UI перестанет зависеть от REST при подписи кнопки. После
этого `isDzenPublish` будет определяться и без `GET /chat/pending`.

### KI-068 — Контракт Smart Document Engine не подтверждён вендором

**Влияние:** `ocr-smart-engine` вызывает `OCR_API_URL` и сводит ответы разных
вендоров к одному тексту (`text`, `result.text`,
`result.textAnnotation.fullText`, `data.text`, `pages[].text`), но точный
контракт конкретного SDE-тарифа (имена полей запроса, авторизация, лимиты)
подтверждается только при получении ключей и документации вендора. Пока ключей
нет, инструмент работает через Tesseract, а он ограничен лимитами песочницы
(`SANDBOX_TIMEOUT_MS` = 10 с, 128 МБ памяти, 0.5 CPU) и непригоден для больших
сканов.

**Обход:** Для облачного OCR задать `OCR_API_URL`, `OCR_API_KEY` и добавить
домен в `OUTBOUND_ALLOWLIST`; для локального — держать `OCR_TESSERACT_ENABLED=true`
и распознавать постранично/небольшими изображениями.

**План:** После подписания договора с вендором зафиксировать контракт в
`docs/integrations` и в Zod-схеме сервиса, добавить smoke-тест против sandbox
стенда вендора.

### KI-069 — Ограничения собственного PDF-парсера и DOCX-генератора

**Влияние:** `extract_pdf` реализован без внешних бинарников (xpdf/poppler) и
поддерживает: объекты `N 0 obj`, `/FlateDecode`, object streams PDF 1.5+
(`/Type /ObjStm`), дерево страниц, текстовые операторы, `ToUnicode` CMap и
WinAnsi. Не поддерживаются: шифрование (`/Encrypt` — предупреждение и пустой
текст), фильтры кроме `/FlateDecode`, CID-шрифты без `ToUnicode`, извлечение
изображений и таблицы с объединёнными ячейками (таблица восстанавливается по
геометрии колонок). `write_docx` не формирует `numbering.xml` (списки — маркер
`•` в абзаце), не поддерживает объединённые ячейки и стили пользователя.
Извлечение основной суммы (`document-analyzer`) — эвристика «максимальная
сумма с валютой».

**Обход:** Для сканированных PDF использовать `ocr-smart-engine`; результат
`document-analyzer` всегда показывать с `raw`/контекстом и `warnings`. Для
сложной вёрстки DOCX собирать документ в шаблоне Word вручную.

**План:** Добавить fallback на `pdftotext` из `sandbox` (пакет уже есть в
образе) при неизвестном фильтре, поддержку `numbering.xml` в `docx-writer`,
и E2E-набор из реальных PDF/DOCX (см. «Что не вошло» Sprint 20).

### KI-070 — Загруженные документы не хранятся и не проверяются антивирусом

**Влияние:** `POST /documents` держит файл в памяти (multer memory storage,
лимит 15 МБ), сразу парсит и не сохраняет: `id` ответа — одноразовый
идентификатор, повторно скачать/переобработать документ нельзя. Нет
антивирусной проверки, карантина и per-user квоты; `sandbox/Dockerfile`
содержит `pdftotext`/`pandoc`, которые API пока не использует (они нужны
smoke-скрипту `scripts/test-documents.sh`).

**Обход:** Не загружать документы из недоверенных источников; для повторного
анализа передавать файл в `extract_pdf`/`extract_document_data` через каталог
`DOCUMENTS_INPUT_DIR` (монтируется в compose).

**План:** Ввести хранилище (S3/MinIO или диск с TTL), антивирус (ClamAV),
квоты и повторную выдачу документа по `id`; тогда же решить, нужен ли
`pdftotext`-fallback из KI-069.

### KI-071 — Адаптер OCR не передаёт `x-folder-id` Yandex Vision

**Влияние:** `OcrSmartEngineService` отправляет
`{content, mimeType, language}` и авторизацию из `OCR_API_AUTH_HEADER`/
`OCR_API_AUTH_PREFIX` (по умолчанию `Authorization: Bearer`). Этого достаточно
для on-prem SDE и простых SDE-совместимых API, но Yandex Vision OCR требует
заголовок `x-folder-id` с идентификатором каталога и поле `languageCodes`
(массив) вместо `language`, а в качестве токена — IAM-токен. Домен
`ocr.api.cloud.yandex.net` уже в allowlist, однако без доработки облачный
запрос вернёт 400/403 и уйдёт в Tesseract-fallback.

**Обход:** Использовать on-prem SDE без `x-folder-id` или прокси, который
добавляет заголовок и переименовывает `language` в `languageCodes`. Для
Yandex Vision — задать `OCR_API_URL` на прокси и хранить IAM-токен в
`OCR_API_KEY`.

**План:** Добавить необязательный `OCR_API_EXTRA_HEADERS` (JSON) и режим
тела запроса (`language`/`languageCodes`) либо отдельный
`OCR_FOLDER_ID` в сервис и `.env.example`, покрыть тестом nock с проверкой
заголовка и тела; после этого закрыть KI-071 и уточнить KI-068.

### KI-072 — Размер sandbox-образа вырос из-за документных утилит

**Влияние:** `sandbox/Dockerfile` теперь содержит `pandoc-cli` (~220 МБ),
`tesseract-ocr` с языками `rus`/`eng` (~42 МБ данных) и `poppler-utils`.
Итоговый образ — ~624 МБ вместо ~380 МБ. Это увеличивает время `docker build`
в CI (шаг `Test Sandbox Documents`) и первую загрузку образа на узел; на
маломощных узлах возможен долгий старт первого навыка.

**Обход:** Кэшировать слой `apk add` в CI (BuildKit cache) и держать образ
загруженным на узлах; для сценариев без документов использовать отдельный
образ без `pandoc`/`tesseract`.

**План:** Разделить образы: базовый `skillwharf-sandbox` и
`skillwharf-documents` с `pandoc`/`tesseract`; выбирать образ по навыку через
`SANDBOX_IMAGE`. Решение принимать после замеров реального использования
документных инструментов.

### KI-073 — Открытая регистрация пользователей

**Влияние:** Любой желающий может создать учетную запись, если знает URL. Эндпоинт защищен только rate-limit (10 попыток в час). Для закрытого пилота или Enterprise-внедрения это создает риск неконтролируемого роста пользователей и спама.
**Обход:** На уровне reverse-proxy (Caddy) ограничить доступ к `/api/v1/auth/register` по IP-адресам офиса, либо временно отключить маршрут.
**План:** Внедрить флаг `REGISTRATION_ENABLED` в `.env` (по умолчанию `false` для production) или систему инвайт-кодов (Invite-only).

### KI-074 — Отсутствие REST-эндпоинта для чата

**Влияние:** Общение с агентами происходит исключительно через WebSocket (Socket.IO). Swagger UI и Postman не могут напрямую протестировать отправку сообщений в чат без написания кастомного клиента (например, на Node.js).
**Обход:** Использовать приложенный Node.js-скрипт с `socket.io-client` (пример есть в `docs/openapi/README.md`).
**План:** Добавить вспомогательный REST-эндпоинт `POST /api/v1/chat/message` (синхронный или с SSE), который будет транслировать запрос в WebSocket-шину для удобства интеграций и тестирования.
