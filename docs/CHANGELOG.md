# Changelog

Все значимые изменения в проекте документируются в этом файле.

## [Unreleased]

### Маркетинг: питч и продающие материалы под v3.0.0

- `docs/marketing/pitch/create_pitch.py`: питч-дек переработан с 6 слайдов
  `v1.0.0-ga` на 7 слайдов релиза `v3.0.0`: титул, проблема/решение B2B, стек
  для РФ (1С OData, Диадок/СБИС, Честный ЗНАК), омниканальность и UX
  (Telegram/Mini App, VK Teams/Пачка/Яндекс, Artifacts Canvas, Cron), 152-ФЗ и
  экономика LLM (PII-маскирование, Vault/Yandex KMS, Cascade + Semantic Cache),
  No-Code/Маркетплейс (A–L, Evals, Developer Portal, 85/15) и внедрение за
  3 дня с тарифами. `SkillWharf_Pitch.pptx` пересобран (7 слайдов).
- Добавлен `docs/marketing/Sales-One-Pager-and-Pilot-Checklist.md`: КП для
  генерального, коммерческого и ИТ-директора, матрица ценности по ролям,
  критерии пилота и пошаговый чек-лист онбординга Design Partner за 3 дня.
- Обновлены `docs/marketing/pitch/README.md` и `docs/README.md` (ссылки на
  питч и продающий одностраничник).

## [3.0.0] - 2026-11-20

Финальный релиз стратегической дорожной карты: этапы 8–11 (Спринты 37–44)
завершены. Платформа получила Interactive Artifacts и Execution DAG Inspector,
Knowledge Hub с цитированием и голосовой ввод, омниканальность (Telegram, VK
Teams, Пачка, Яндекс Мессенджер), юридически значимый ЭДО и маркировку,
Cron-планировщик, 152-ФЗ PII-маскирование и Smart Model Cascade. Тег релиза
создаёт Владелец продукта.

### Sprint 44: 152-ФЗ PII-маскирование и Smart Model Cascade (PII-44.1–44.2, WEB-44.2)

**Бэкенд (PII-44.1/44.2, CASCADE-44.1): маскирование и каскад моделей.**

- `PiiMaskingService`: маскирование телефонов РФ, email, СНИЛС, контекстных
  ИНН/паспорта и банковских карт (контрольная сумма Луна) в токены вида
  `[PHONE_1]`. Соответствие токен→значение хранится **только в памяти одного
  запроса** — не пишется в БД, Redis или логи.
- `ChatService` маскирует сообщения, системный промпт и memory-context перед
  отправкой в llm-worker, затем локально восстанавливает значения в ответе и
  артефактах; `piiMaskedCount` попадает в `stream_end` и `Message.metadataJson`.
- `ModelCascadeService`: классификатор `lite`/`standard`/`flagship` (длина,
  инструменты, маркеры «договор», «сверка», «аудит», «код» и др.); при
  `LLM_CASCADE_ENABLED=true` простые запросы идут на `LLM_CASCADE_LITE_MODEL`,
  `modelTier` передаётся в метаданных ответа.
- Переменные `PII_MASKING_ENABLED=false`, `LLM_CASCADE_ENABLED=false` и
  `LLM_CASCADE_LITE_MODEL` добавлены в `.env.example` и проброшены в сервис
  `api` в `docker-compose.yml`.

**Web UI (WEB-44.2): бейджи защиты ПДн и уровня модели в чате.**

- `apps/web/src/lib/message-metadata.ts`: опциональные поля `piiMaskedCount`
  (int ≥ 0) и `modelTier` (`lite`/`standard`/`flagship`) в
  `assistantMessageMetadataSchema`, хелперы условий отображения бейджей.
- `ChatPage`: рядом с бейджем кеша показываются зелёный бейдж «152-ФЗ:
  обезличено N ПДн» с подсказкой о токенизации/локальной демаскировке и бейдж
  «Smart Cascade · …» с подписью уровня модели; бейджи появляются только при
  положительном счётчике ПДн и заданном уровне модели.
- RU/EN-ключи `chat.piiMasked.*`, `chat.modelTier.*` и unit-тесты. Все задачи
  Sprint 44 отмечены `[x]` в `ROADMAP-V3.md`.

### Sprint 43: Cron-планировщик, дайджесты и расписания (CRON-43.1–43.3)

**Бэкенд (CRON-43.1/43.2): планировщик и доставка дайджестов.**

- Модель `ScheduledAgentJob` + миграция `20261120140000_add_scheduled_agent_jobs`:
  cron, таймзона, промпт, канал доставки, `nextRunAt` и журнал последнего запуска.
- `parseCronExpression`/`computeNextCronRun`: детерминированный расчёт для `*`,
  чисел, списков, диапазонов и шагов (`*/15`) с учётом IANA-таймзон и DST;
  cron валидируется Zod.
- `ScheduledJobsService`: тик с Redis-блокировкой `scheduler:jobs:lock`
  (`SET NX PX 15000`, Lua-освобождение по токену), `SCHEDULER_POLL_MS=0`
  отключает тик. `executeJob` запускает диалог в `ChatService`, сохраняет
  статус/выжимку и пересчитывает `nextRunAt`.
- Доставка результата в Telegram (`X`-токен канала) или корпоративный канал
  через адаптер; best-effort, не роняет задачу.
- REST (owner/admin/operator): `GET|POST /workspaces/:id/schedules`,
  `PATCH|DELETE .../:jobId`, `POST .../:jobId/run-now`. Переменная
  `SCHEDULER_POLL_MS=30000` добавлена в `.env.example` и проброшена в сервис
  `api` в `docker-compose.yml`.

**Web UI (CRON-43.3): страница `/app/schedules`.**

- `apps/web/src/lib/schedules.ts`: Zod-схемы задачи и формы, валидация
  5-полевого cron, пресеты расписаний, клиент
  `/workspaces/:workspaceId/schedules` с созданием, обновлением, удалением и
  `POST .../run-now`, категории ошибок.
- `SchedulesPage`: защищённый маршрут `/app/schedules` и пункт навигации;
  конструктор с пресетами, cron, таймзоной, заданием и выбором канала доставки
  (Telegram/корпоративный) из подключённых каналов воркспейса; список задач со
  статусом, временем запуска, итогом последнего выполнения, паузой, запуском
  сейчас и удалением. RU/EN-ключи и unit-тесты; все задачи Sprint 43 отмечены
  `[x]` в `ROADMAP-V3.md`.

### Sprint 42: маркировка DataMatrix / ГИС МТ «Честный ЗНАК» (MARK-42.1–42.3)

**MCP-сервер ГИС МТ (MARK-42.1): `infra/mcp/marking/server.mjs`.**

- `infra/mcp/marking/server.mjs` (новый): MCP-сервер с `GET /sse`,
  `POST /messages`, `GET /health` и constant-time `MCP_AUTH_TOKEN`. Per-request
  `X-Marking-Token` / `X-Marking-Inn` (ИНН 10 или 12 цифр) с fallback на
  `MARKING_TOKEN` / `MARKING_INN`; базовый адрес `MARKING_API_URL` (`https://crpt.ru`).
- Инструменты: `marking_check_codes` (`POST /cises/info`, нормализация `cis`,
  `status`, `ownerInn`, `productName`, `gtin`, `expirationDate`),
  `marking_document_status` (`GET /doc/{docId}/info`) и
  `marking_create_discrepancy_draft` (черновик `draftOnly: true` без подписи и
  отправки). Retry до 2 попыток на 429/5xx; Bearer-токены и DataMatrix-коды
  маскируются в ошибках.
- Dockerfile, 8 тестов на `node:test`, сервис `marking-mcp` на
  `127.0.0.1:5007` с healthcheck в `docker-compose.mcp.yml`, `MARKING_MCP_URL`
  в API и переменные в `.env.example`. Обновлён
  `docs/architecture/MCP-ERP-Connectors.md`.

**Бэкенд (MARK-42.2): подключение и инструменты маркировки.**

- Провайдер `chestny_znak`: `{token, inn}` шифруется целиком через
  `TokenCipherService`, ИНН валидируется Zod (`^\d{10}(\d{2})?$`),
  `POST/DELETE /integrations/chestny_znak`. В GET — только `innMasked`,
  токен не возвращается и не логируется.
- `MarketplaceMcpService` передаёт `X-Marking-Token` / `X-Marking-Inn` в
  `MARKING_MCP_URL`; имена MCP-действий приведены к контракту
  `infra/mcp/marking/server.mjs` (проверка кодов и черновик расхождений).
- Три инструмента: `marking_check_codes`, `marking_verify_shipment`,
  `marking_report_violation`. Сверка партии детерминированная: выбывшие марки,
  чужой ИНН, просрочка, недостача/пересорт по GTIN → `{valid, issues}`.
- Политики: `approval: 'always'` для `marking_report_violation`,
  `priceRub: 15` для инструментов маркировки. Стартовый навык
  `starter-skills/chestny-znak-marking/SKILL.md`.

**Web UI (MARK-42.3): карточка «Честный ЗНАК» в `/app/settings`.**

- `apps/web/src/lib/integrations.ts`: Zod-схема `chestnyZnakCredentialsSchema`
  (Bearer-токен True API и ИНН 10/12 цифр), статус `chestny_znak` в
  `GET /integrations` с поддержкой поля `innMasked`, клиенты подключения и
  отключения, отдельный ключ ошибки карточки.
- `IntegrationsSection`: карточка с подсказкой о проверке кодов DataMatrix на
  складе, в опте и на ПВЗ; токен через `SecretField`, валидация ИНН до запроса
  к API. Добавлена векторная иконка DataMatrix в `IntegrationIcon.tsx`.
- RU/EN-ключи и unit-тесты. Все задачи Sprint 42 отмечены `[x]` в `ROADMAP-V3.md`.

### Sprint 41: ЭДО Контур.Диадок и СБИС (EDO-41.1–41.4)

**MCP-шлюз ЭДО (EDO-41.1): `infra/mcp/edo/server.mjs`.**

- `infra/mcp/edo/server.mjs` (новый): MCP-сервер с `GET /sse`, `POST /messages`,
  `GET /health` и constant-time авторизацией `MCP_AUTH_TOKEN`. Per-request
  заголовки `X-Edo-Provider` (`diadoc`/`sbis`), `X-Edo-Api-Key`, `X-Edo-Token`,
  `X-Edo-Box-Id` с fallback на `EDO_*`; адреса `DIADOC_API_URL`/`SBIS_API_URL`.
- Инструменты: `edo_list_incoming_documents` (Диадок `V3/GetDocuments` с
  `Any.InboundNotFinished` / СБИС `СБИС.СписокДокументов`),
  `edo_get_document_details` (реквизиты и товарные позиции),
  `edo_prepare_sign_packet` (пакет к подписанию КЭП без самой подписи) и
  `edo_reject_document` (уведомление об уточнении). Диадок использует
  `DiadocAuth`, СБИС — `X-SBISSessionID` и JSON-RPC; retry до 2 попыток на
  429/5xx, токены маскируются в ошибках.
- Dockerfile, 12 тестов на `node:test`, сервис `edo-mcp` на `127.0.0.1:5006`
  с healthcheck в `docker-compose.mcp.yml`, `EDO_MCP_URL` в API и переменные в
  `.env.example`. Обновлён `docs/architecture/MCP-ERP-Connectors.md`.

**Бэкенд (EDO-41.2/41.3): подключения и инструменты агента.**

- Новые провайдеры ключей `diadoc` (`apiKey`/`boxId`/`token`) и `sbis`
  (`token`/`boxId`): `POST/DELETE /integrations/diadoc|sbis`, шифрование всего
  JSON через `TokenCipherService`, в GET — только `boxId`.
- `McpProvider` расширен ЭДО: `MarketplaceMcpService` пробрасывает
  `X-Edo-Provider`, `X-Edo-Api-Key`, `X-Edo-Token`, `X-Edo-Box-Id` в
  `EDO_MCP_URL` (ключи пользователя или env-fallback).
- Четыре инструмента (`edo_list_incoming_upd`, `edo_get_document_details`,
  `edo_reconcile_with_erp`, `edo_prepare_sign_packet`) с Zod-валидацией.
  Сверка детерминированная, деньги сравниваются в копейках и возвращают
  `matched` + `discrepancies` (количество/цена/итог/отсутствующие позиции).
- Политики: `approval: 'always'` для `edo_prepare_sign_packet`, `priceRub: 25`
  для сверки и подготовки пакета. Стартовый навык
  `starter-skills/edo-diadoc-sbis/SKILL.md` с регламентом проверки УПД.

**Web UI (EDO-41.4): карточки Диадок и СБИС в `/app/settings`.**

- `apps/web/src/lib/integrations.ts`: Zod-формы `diadocCredentialsSchema`
  (`apiKey`, `boxId`, `token`) и `sbisCredentialsSchema` (`token`, `boxId`),
  статусы `diadoc`/`sbis` в `GET /integrations`, клиенты подключения и
  отключения, категории ошибок для новых карточек.
- `IntegrationsSection`: карточки «Контур.Диадок (ЭДО)» и «СБИС / Saby (ЭДО)»
  с подсказкой про проверку УПД, сверку с 1С/МойСклад и подготовку пакетов на
  подпись КЭП; секреты через `SecretField`, валидация до запроса к API.
- Векторные иконки Диадока и СБИС в `IntegrationIcon.tsx`, RU/EN-ключи и
  unit-тесты. Все задачи Sprint 41 отмечены `[x]` в `ROADMAP-V3.md`.

### Sprint 40: Корпоративные мессенджеры РФ (VK Teams, Пачка, Яндекс)

**Бэкенд (OMNI-40.1/40.2): единый шлюз и адаптеры.**

- Модель `CorpMessengerChannel` + миграция
  `20261120130000_add_corp_messenger_channels`: `provider`, `apiBaseUrl`,
  `encryptedBotToken`, `webhookSecret`, `allowedChatIds`, активность.
- `ICorpMessengerAdapter` (`parseIncomingWebhook`, `sendTextMessage`) и реестр
  трёх адаптеров: VK Teams, Пачка, Яндекс Мессенджер. Входящие события и
  HTTP-ответы валидируются Zod, токены шифруются через `TokenCipherService`.
- REST (owner/admin): `GET|POST /workspaces/:id/channels/corporate` и
  `DELETE .../:channelId`. В GET — только `tokenMasked`; `webhookSecret`
  возвращается один раз при создании.
- `POST /webhooks/corporate/:channelId`: constant-time проверка
  `X-Webhook-Secret`/`X-Signature`, фильтр `allowedChatIds`, запуск
  `ChatService`, отправка ответа или HITL-кнопок одобрения/отклонения
  (`hitl:<action>:<runId>`) через адаптер провайдера.

**Web UI (OMNI-40.3/40.4): настройки корпоративных каналов в `/app/settings`.**

- `apps/web/src/lib/corp-channels.ts`: Zod-схемы провайдеров `vk_teams`,
  `pachca`, `yandex_messenger`, канала и формы подключения (валидация
  http(s) `apiBaseUrl`, парсинг Chat ID), клиент
  `/workspaces/:workspaceId/channels/corporate`, категории ошибок.
- `CorpChannelsSection`: секция в `/app/settings` с карточками провайдеров и
  подсказками по токену, скрытым полем токена, полем on-premise Base URL,
  списком Chat ID, одноразовым Webhook Secret и Webhook URL с копированием,
  списком каналов и отключением. RU/EN-ключи и unit-тесты; все задачи
  Sprint 40 отмечены `[x]` в `ROADMAP-V3.md`.

### Sprint 39: Telegram-бот, Mini App и HITL в мессенджере

**Бэкенд (OMNI-39.1/39.2, HITL-39.3): канал, голос/фото и inline-одобрения.**

- Модель `TelegramChannel` + миграция `20261120120000_add_telegram_channels`:
  `encryptedBotToken` (envelope `TokenCipherService`), `webhookSecret`,
  `allowedChatIds`, `botUsername`, активность и время последнего сообщения.
  Открытый токен не попадает ни в GET, ни в логи — только маска `****xxxx`.
- REST (роли owner/admin воркспейса): `GET|POST /workspaces/:id/channels/telegram`
  и `DELETE .../channels/telegram/:channelId`. При создании — `getMe` и
  `setWebhook` с `secret_token` (отключается `TELEGRAM_SKIP_API_CALLS=true`);
  секрет возвращается один раз в ответе создания.
- Публичный `POST /webhooks/telegram/:channelId`: constant-time проверка
  `X-Telegram-Bot-Api-Secret-Token`, фильтр `allowedChatIds` (пустой список
  привязывает первый чат), текстовые сообщения, голос (File API →
  `SpeechToTextService`) и фото с метаданными/file_id.
- HITL: при `pendingApproval` — inline-клавиатура approve/reject с `runId` =
  conversationId; `callback_query` проверяет владельца беседы, вызывает
  `approveAction`, отвечает на callback и редактирует сообщение.
- Переменные `TELEGRAM_API_BASE_URL`, `TELEGRAM_WEBHOOK_BASE_URL` и
  `TELEGRAM_SKIP_API_CALLS` добавлены в `.env.example` и проброшены в сервис
  `api` в `docker-compose.yml`.

**Web UI (OMNI-39.4): настройки канала и Mini App `/tg-app`.**

- `src/lib/telegram-channels.ts`: Zod-схемы канала и формы подключения (токен
  `@BotFather`, парсинг Chat ID из запятых/переносов), клиент
  `/workspaces/:workspaceId/channels/telegram` и локализованные категории
  ошибок.
- `TelegramChannelsSection`: секция в `/app/settings` с инструкцией по
  `@BotFather`, скрытым полем токена, списком Chat ID, карточками ботов,
  копируемым Webhook URL и отключением.
- `TelegramMiniAppPage`: маршрут `/tg-app` без десктопного сайдбара,
  инициализация `Telegram.WebApp`, статус офиса, метрики, крупные кнопки
  одобрения HITL и быстрые ссылки на бота/веб-версию. RU/EN-ключи и
  unit-тесты; все задачи Sprint 39 отмечены `[x]` в `ROADMAP-V3.md`.

### Sprint 38: Knowledge Hub, цитаты, голосовой ввод и PWA

**Бэкенд (API-38.0): папки знаний, цитаты и Speech-to-Text.**

- Модель `KnowledgeFolder` и поля `MemoryChunk.folderId/documentTitle/pageNumber`,
  а также миграция `20261120110000_add_knowledge_folders`.
- `GET|POST /api/v1/knowledge/folders`, `DELETE .../folders/:id` (удаление только
  владельцем, 403), `GET /api/v1/knowledge/documents` с фильтрами `folderId` и
  `search`. Все входные/выходные данные — Zod.
- Расширенный поиск в `PgVectorMemoryStore`/`QdrantVectorStore` возвращает
  метаданные чанков; `ChatService` строит `citations` и пишет их в
  `Message.metadataJson` и `stream_end`.
- `SpeechToTextService` + `POST /api/v1/chat/transcribe`: `STT_PROVIDER=mock`
  (по умолчанию), Whisper и Yandex SpeechKit через Zod-валидируемые ответы,
  multipart-поле `audio` или JSON `audioBase64`, лимит 15 МБ и список MIME.
  Переменные `STT_PROVIDER`, `STT_WHISPER_URL`, `YANDEX_STT_IAM_TOKEN`
  добавлены в `.env.example` и проброшены в сервис `api` в `docker-compose.yml`.

**Web UI (KB-38.1/38.2, VOICE-38.1, WEB-38.2).**

- `apps/web/src/lib/knowledge.ts`: Zod-схемы и клиент папок/документов Базы
  знаний (`/knowledge/folders`, `/knowledge/documents`), загрузка регламента и
  `transcribeVoiceAudio` (`POST /chat/transcribe`). `message-metadata.ts`
  расширен необязательным массивом `citations`.
- `KnowledgeHubPage`: защищённый маршрут `/app/knowledge` и пункт навигации;
  папки регламентов (создание/выбор/удаление), поиск, фильтр по папке,
  загрузка документа и статусы индексации. Ошибки API локализованы.
- `CitationBadges`: кликабельные сноски в ответе ассистента с подсвеченным
  фрагментом, номером страницы и переходом в Knowledge Hub по `chunkId`.
- Голосовой ввод в чате через `getUserMedia`/`MediaRecorder` с таймером и
  индикатором записи; результат транскрибации подставляется в поле ввода,
  неподдерживаемые браузеры получают подсказку.
- PWA-манифест `public/manifest.webmanifest` и `<link rel="manifest">` в
  `index.html`. RU/EN-ключи и unit-тесты на новые схемы и клиенты; задачи
  `KB-38.1`, `KB-38.2`, `VOICE-38.1` и `WEB-38.2` отмечены `[x]` в `ROADMAP-V3.md`.

### Планирование: дорожная карта v2.1.0 — v3.0.0

- Добавлен `docs/development/ROADMAP-V3.md`: 4 стратегических этапа и
  8 спринтов (37–44) с уникальными ID задач и чекбоксами для агентов. План
  покрывает Interactive Artifacts/Canvas и Execution DAG Inspector, Knowledge
  Hub с цитированием и голосовой ввод/PWA, Telegram-бота с HITL и Mini App,
  корпоративные мессенджеры РФ (VK Teams, Пачка, Яндекс Мессенджер),
  MCP-коннекторы Диадок/СБИС и маркировку «Честный ЗНАК»/ЕГАИС, Cron-планировщик,
  152-ФЗ PII-маскирование и Smart Model Cascade. Базой служит релиз `v2.0.0`;
  ссылка добавлена в `docs/README.md`.

### Sprint 37: Interactive Artifacts, Canvas и Execution DAG Inspector

**Бэкенд и Worker (API-37.0): парсер, refine API, ExecutionTraceCollector.**

- Контракты `artifactItemSchema` (`document|table|code`) и
  `executionStepSchema` (`stepIndex`, `name`, `toolName?`, `durationMs`,
  `status`, `costRub?`) в API и llm-worker; `done` и `stream_end` несут
  дополнительные поля `artifacts` / `executionTrace`.
- `parseArtifacts`: извлечение `<skillwharf-artifact type="..." title="...">`
  и fenced-блоков с `title="..."`; служебные теги убираются из текста ответа.
- `Message.metadataJson` + миграция `20261120100000_add_message_metadata`:
  `ChatService` сохраняет артефакты, трассу и `cacheHit` в метаданных ассистента
  и отдаёт их в `stream_end`.
- `POST /api/v1/chat/artifacts/refine`: Zod-валидация запроса (в т.ч.
  `selectedText` должен входить в `fullContent`), точечный промпт в LLM через
  `LlmRouterService`, ответ `{updatedContent, summary}` через Zod.
- `llm-worker`: `ExecutionTraceCollector` собирает шаги из `updates`-потока
  графа, завершений инструментов, событий `agent_handoff` и HITL; трасса
  добавляется в событие `done`.

**Web UI (UX-37.1/37.2/37.3): ArtifactCanvasDrawer и ExecutionTraceAccordion.**

- `src/lib/artifacts.ts`: Zod-контракты артефактов и трассы, парсинг метаданных
  сообщения и клиент `refineArtifact` для точечной правки фрагмента.
- `src/components/chat/ArtifactCanvasDrawer.tsx`: выдвижная панель с
  редактированием выбранного фрагмента, превью и экспортом в
  `.md`/`.csv`/`.html`/`.doc` (расширения `.xlsx`/`.pdf` — через документный
  пайплайн отдельной задачей).
- `src/components/chat/ExecutionTraceAccordion.tsx`: сворачиваемый инспектор
  шагов агента (инструмент, длительность, стоимость, статус HITL) в карточке
  ответа; RU/EN-ключи и unit-тесты.

### Производительность: Splitting бандла лендинга

- `apps/web/vite.landing.config.ts`: добавлен
  `build.rollupOptions.output.manualChunks` — отдельные чанки `react-vendor`,
  `motion-vendor`, `i18n-vendor`, `vendor` и `landing-data` с данными 12 треков.
- `apps/web/src/pages/LandingPage.tsx`: интерактивный симулятор AI-Офиса,
  секция заявки Design Partner и модалка деталей трека переведены на
  `React.lazy` + `Suspense` с заглушками, сохраняющими высоту секций.
  Первый экран больше не ждёт код нижележащих блоков; предупреждение Vite
  «Some chunks are larger than 500 kB» устранено (основной JS-чанк лендинга
  уменьшен с 812 кБ до 195 кБ). Функциональность симулятора A–L, RU/EN и формы
  заявки сохранена.

## [2.0.0] - 2026-11-19

Финальный релиз стратегической дорожной карты: этапы 4–7 (Спринты 29–36)
завершены. Платформа включает Eval-рейлсы, Multi-Agent Supervisor,
Organization/Workspace с RBAC/ABAC, 1С OData-коннектор, Transactional Outbox
с Platform Treasury, внешние KMS (Vault/Yandex), Visual Agent Builder и
Developer Portal с аудитом безопасности навыков. Тег релиза создаёт Владелец
продукта.

### Sprint 36: Developer Portal и аудит безопасности навыков

**Бэкенд портала и статический аудит (DEVPORTAL-36.0/36.1).**

- `MarketplaceSkill`: поля `auditStatus` (`passed|warning|rejected`) и
  `auditFindingsJson` + миграция `20261119150000_add_marketplace_skill_audit`.
- `SkillSecurityAuditService`: детерминированный статический аудит манифеста и
  текста SKILL.md. `critical` (cloud metadata `169.254.169.254`, приватные
  сети, `rm -rf /`, `mkfs`, `dd if=`, `/etc/shadow`, `.env`) → `rejected`;
  `warning` (нет подписи Ed25519, `filesystem:write`, >5 доменов egress) →
  `warning` с пометкой. Отчёт валидируется Zod.
- `GET /api/v1/developer/skills`: список навыков автора с KPI — установки,
  `author_revenue_share` из Ledger (85%) и ожидающие выплаты из `BillingOutbox`
  (`pending`/`processing`, payload через Zod).
- `POST /api/v1/developer/skills`: приём SKILL.md, проверка подписи Ed25519 и
  аудит; при `rejected` — 400 `errors.skill_audit_rejected` с массивом
  `findings` (новый помощник ошибки и ключ i18n), при `passed`/`warning` —
  публикация с сохранением вердикта. `PATCH .../payout` — смена счёта только
  владельцем навыка (403).
- Тесты: 6 тестов аудита и 5 тестов портала (блокировка `169.254.169.254`,
  `rm -rf`, отсутствие подписи, публикация, KPI, защита payout).

**Web UI: страница `/app/developer` (WEB-36.3).**

- `src/lib/developer-portal.ts` (новый): Zod-контракты портала —
  `auditFindingSchema` (`critical|warning|info`), `developerSkillItemSchema`
  (Decimal `price` → число, `auditStatus`, `auditFindings?`,
  `payoutAccountId?`), `developerDashboardSchema` (KPI + `skills`,
  денежные строки → числа, обёртка `{ dashboard }`), строгая форма
  `publishDeveloperSkillSchema`. Клиенты `fetchDeveloperDashboard`,
  `publishDeveloperSkill`, `updateSkillPayoutAccount` для `/developer/skills`.
- Обработка отказа аудита: `DeveloperPortalError` с полем `findings`,
  `parseAuditFindings` (поддерживает `findings`/`details`) и
  `isSkillAuditRejected` для кода `errors.skill_audit_rejected` (400/422).
  Категории ошибок маппятся в локализованные ключи
  `getDeveloperPortalErrorMessage` / `DEVELOPER_ERROR_KEYS`.
- `src/pages/DeveloperPortalPage.tsx` (новый): защищённая страница
  `/app/developer` — четыре KPI-карточки автора, форма публикации `SKILL.md`
  (YAML-шаблон, Markdown-инструкция, Payout Account ID) со списком критических
  замечаний аудита под формой, таблица навыков с бейджами Passed/Warning/
  Rejected (тултип с findings) и инлайн-редактированием счёта выплат.
- `src/App.tsx`: ленивый маршрут `/app/developer` под `ProtectedRoute`.
- Навигация: пункт «Разработчикам» / `Developer Portal` рядом с
  маркетплейсом в сайдбаре и шапках страниц.
- RU/EN-ключи `nav.developer`, `errors.skill_audit_rejected` и
  `developerPortal.*`; unit-тесты `src/lib/developer-portal.test.ts`:
  схемы, coercion Decimal, отказ аудита с findings и клиентские вызовы.

### Sprint 35: CustomAgentRole и Visual No-Code Agent Builder

**Бэкенд и Worker: модель, CRUD и подхват ролей (BUILDER-35.0).**

- Модель `CustomAgentRole` + миграция: `roleKey` уникален в паре с
  `workspaceId`, хранит `systemPrompt`, `skillSlugs`, `hitlPolicy`,
  `dailyBudgetRub` и `isActive`.
- `CustomAgentRolesController` / `CustomAgentRolesService`:
  `GET|POST /api/v1/workspaces/:workspaceId/agents`,
  `PATCH|DELETE /api/v1/workspaces/:workspaceId/agents/:agentId`. Чтение — всем
  участникам, изменение — `owner`/`admin` (403
  `errors.insufficient_workspace_role`). Все входные/выходные данные — Zod.
- `ChatService` подхватывает активные роли дефолтного воркспейса: их `roleKey`
  добавляются в `agentRoles` графа, а инструкции, навыки, HITL и бюджет —
  в системный промпт сессии. Контракт `agentRoleSchema` расширен кастомными
  kebab-slug (API и llm-worker), handoff-события принимают такие роли.
- Тесты: CRUD и RBAC (viewer/operator → 403), валидация `roleKey`/бюджета,
  подхват ролей в `ChatService` — 8 + 1 новых тест.

**Web UI: страница `/app/builder` (BUILDER-35.1, BUILDER-35.3).**

- `src/lib/agent-builder.ts` (новый): Zod-контракт кастомных агентов —
  `hitlPolicySchema` (`never|high_risk|always`), `customAgentRoleSchema`
  (бюджет приводится из Decimal-строки к числу), строгая форма
  `createCustomAgentSchema` с автогенерацией `roleKey` из названия
  (`generateRoleKey`, транслитерация кириллицы → kebab-case) и отдельный
  PATCH-контракт. Клиенты `fetchWorkspaceAgents`, `createWorkspaceAgent`,
  `updateWorkspaceAgent`, `deleteWorkspaceAgent` для
  `/api/v1/workspaces/:id/agents`, ключ кэша `['workspace-agents', id]`.
- `src/pages/AgentBuilderPage.tsx` (новый): защищённая страница `/app/builder`
  с двухколоночным интерфейсом — слева форма (название стола, описание,
  чекбоксы установленных навыков, системный промпт с пресетами «Менеджер
  продаж»/«Аналитик склада»/«Контролёр документов», регламент HITL и дневной
  бюджет), справа живое превью карточки AI-Офиса и список агентов воркспейса
  с переключателем активности и удалением. Роль `viewer` не может менять
  агентов; 404/ошибки показываются локализованно.
- `src/App.tsx`: ленивый маршрут `/app/builder` под `ProtectedRoute`.
- Навигация: пункт «Конструктор» / `Agent Builder` (`nav.builder`) в сайдбаре
  чата и в шапках страниц приложения.
- RU/EN-ключи `nav.builder` и `builder.*`; unit-тесты
  `src/lib/agent-builder.test.ts` (18 тестов): схемы, транслитерация
  `roleKey`, парсинг бюджета и клиентские вызовы.

### Sprint 34: внешний KMS и горизонтальное масштабирование

**KMS-провайдеры: HashiCorp Vault Transit и Yandex Cloud KMS (KMS-34.1/34.2, KI-053).**

- Интерфейс `IKmsEnvelopeProvider` + `LocalAesKmsProvider` (дефолт,
  `KMS_PROVIDER=local`). `VaultTransitKmsProvider` (`vault`) шифрует через
  `/v1/transit/encrypt/<key>` и пишет `kms:vault:<key>:<ciphertext>`;
  `YandexCloudKmsProvider` (`yandex-kms`) — `kms:yandex:<key>:<ciphertext>`.
  Конфигурации и ответы KMS валидируются Zod, DI только через конструктор.
  Чтение legacy `v1:`/`v2:` сохранено.
- `CredentialRotationService.rotateAllCredentials()` теперь асинхронный и
  мигрирует локальные конверты в `kms:*` при смене `KMS_PROVIDER`, в одной
  транзакции. Unit-тесты: mock HTTP, отвержение невалидных ответов,
  `v2 → kms:vault` и миграция legacy-конверта.

**Redis-блокировка Outbox (HA-34.2).**

- `BillingOutboxService.processPendingBatch()` захватывает распределённую
  блокировку Redis (`SET billing:outbox:lock <ownerToken> NX PX 10000`,
  снятие Lua-скриптом по токену) при заданном `REDIS_URL`; реплика без
  блокировки пропускает тик. Тест: 3 реплики outbox → ровно 1 перевод.
  KI-053 → «Исправлено».

**Инфраструктура и нагрузочный тест (HA-34.1).**

- `.env.example` и `docker-compose.yml`: добавлены `KMS_PROVIDER` (`local` по
  умолчанию, также `vault` и `yandex-kms`), `VAULT_ADDR`, `VAULT_TOKEN`,
  `VAULT_TRANSIT_KEY`, `YANDEX_KMS_KEY_ID` и `YANDEX_KMS_IAM_TOKEN` — все
  проброшены в сервис `api` и используются адаптерами.
- `docker-compose.ha.yml` (новый override): 3 реплики `api` и `llm-worker`,
  2 реплики `sandbox-worker`, снят published-порт у `api` (трафик через Caddy),
  включены `RATE_LIMIT_STORE=redis` и
  `BILLING_OUTBOX_DISTRIBUTED_LOCK=true`.
- `scripts/load-test-ha.mjs` и npm-скрипт `loadtest:ha`: конкурентные запросы
  к `/api/v1/health/ready`, `/api/v1/marketplace/skills` и
  `/api/v1/chat/send` (с `--token`), p50/p95/p99 и RPS, exit 1 при 5xx/сетевых
  ошибках; `--dry-run` проверяет аргументы и расчёт перцентилей без сервера.
- Runbook дополнен разделами про подключение Vault/Yandex KMS и HA-override
  с нагрузочным тестом. Инфраструктурная подзадача HA отмечена `[x]` в
  `ROADMAP-V2.md`.

### Sprint 33: Transactional Outbox, Platform Treasury и клиринг в Admin

**Бэкенд и композиция (OUTBOX-33.1 / OUTBOX-33.2, KI-087).**

- Модель `BillingOutbox` + миграция: выплата автору 85% попадает в БД **в той же
  транзакции**, что и списание покупателя и сплит Ledger; ключ идемпотентности
  `revenue-share:<idempotencyKey>` исключает дубли переводов (KI-087).
- `BillingOutboxService`: atomic-claim задач, отправка через
  `YooKassaProvider.createTransfer`, exponential backoff `2^attempts × 30s`,
  `failed_dead` после 5 попыток, `retryDeadLetter` и периодический тик с
  `unref()` (`BILLING_OUTBOX_POLL_MS=15000`, `0` — отключить).
- Platform Treasury: системный пользователь `treasury@system.skillwharf.local`
  создаётся лениво, комиссия 15% реально увеличивает его `Wallet.balance`
  проводкой `platform_fee` (вместо информационной записи на кошельке покупателя).
- Админ API (роли admin/owner): `GET /admin/billing/treasury`,
  `POST /admin/billing/outbox/:id/retry`, `GET /admin/billing/reconciliation`
  с флагом `balanced` и `discrepancyRub`.
- Тесты: outbox + treasury в одной транзакции, backoff и dead-letter, ручной
  ретрай, reconciliation, без payout-аккаунта outbox не создаётся.
  `pnpm test` — 1608 тестов.

**Web UI: вкладка «Финансы и Клиринг» (WEB-33.3).**

- `src/lib/admin.ts`: Zod-контракты финансового клиринга —
  `billingOutboxItemSchema` (статусы `pending|processing|sent|failed_dead`,
  `attempts`/`maxAttempts`, `lastError`, `createdAt`, `sentAt`),
  `treasurySummarySchema` (`treasuryBalanceRub` как число или Decimal-строка,
  `counts` и `recentOutbox`), `reconciliationReportSchema` (`balanced`,
  `discrepancyRub`, необязательные `ledgerNetRub`/`walletsTotalRub`).
  Decimal-строки приводятся к числам; счётчик `failed_dead` принимает алиас
  `failedDead`. Клиенты `fetchTreasurySummary`, `fetchBillingReconciliation`
  и `retryOutboxItem` (с разбором обновлённой записи или пустого ответа 204)
  для эндпоинтов `/admin/billing/*`. Новые ключи в `adminQueryKeys`.
- `src/components/admin/BillingClearingTab.tsx` (новый): вкладка «Финансы»
  на `/admin?tab=billing` — карточка «Кошелёк платформы (Platform Treasury)»
  с балансом комиссии 15% и счётчиками Outbox, карточка «Сверка Ledger»
  со статусом «Сходится (0 ₽ расхождений)» или предупреждением о расхождении
  и кнопкой «Обновить сверку», таблица «Очередь выплат авторам» со статусами,
  числом попыток, последней ошибкой и кнопкой «Повторить» для `failed_dead`.
  Состояния загрузки/ошибки/пустоты и локализованные сообщения.
- `src/pages/AdminPage.tsx`: новая вкладка `billing` в `TAB_IDS`, `parseTab`,
  таб-листе и рендере панели (поддержка стрелок Home/End сохраняется).
- RU/EN-ключи `admin.tabs.billing`, `admin.billing.*` и
  `admin.errors.treasury/reconciliation/retryOutbox`.
- Unit-тесты `src/lib/admin-billing.test.ts` (18 тестов): схемы, клиенты,
  coercion Decimal-строк, пустой ответ retry и кодирование id.

Переменная `BILLING_OUTBOX_POLL_MS` проброшена в сервис `api` в
`docker-compose.yml`. UI устойчив к отсутствию эндпоинтов (404/501) и
показывает локализованное сообщение. Внешняя сверка с Journal ЮKassa
(`OUTBOX-33.3`) остаётся отдельной задачей.

### Sprint 32: 1С OData, Event-Driven триггеры и настройки в UI

**Бэкенд: провайдер 1С и вебхук-триггеры (CONNECT-32.1/32.2).**

- 1С:Предприятие в API: провайдер `'1c'` в `ProviderKeysService` (шифрованное
  хранение `{odataUrl, username, password}` с Zod-валидацией URL и live-проверкой
  `GET <odataUrl>/$metadata`, `SKIP_INTEGRATION_LIVE_CHECK`), маршруты
  `POST/DELETE /integrations/1c`, проброс `X-1C-OData-Url`/`X-1C-Username`/
  `X-1C-Password` в `MarketplaceMcpService`.
- Четыре инструмента `onec_search_nomenclature`, `onec_check_stock`,
  `onec_check_debt`, `onec_create_order` с Push в MCP, Zod-схемами и
  политикой `approval: 'always'` + Pay-per-Call 20 ₽ для `onec_create_order`
  (и 20 ₽ для остальных 1С-инструментов). Стартовый навык
  `starter-skills/1c-enterprise/SKILL.md` для треков H/J/K/L.
- `WebhookTrigger` + миграция; `GET/POST/DELETE /api/v1/triggers` с привязкой к
  активному воркспейсу (slug и secretToken генерируются `randomBytes`),
  публичный `POST /api/v1/webhooks/triggers/:slug` с constant-time проверкой
  `X-Trigger-Secret`, лимитом payload 32 КБ, подстановкой `{{payload}}`/
  `{{source}}` в шаблон и запуском агента от имени владельца триггера.
- Тесты: заголовки и креды 1С, HITL-политика и вызов `onec_create_order`,
  создание триггера, constant-time секрет, autonomous-диалог и лимит payload.
  `pnpm test` — 1579 тестов.

**MCP-сервер 1С через OData (инфраструктура, CONNECT-32.1).**

- `infra/mcp/1c/server.mjs`: Node.js ESM MCP-сервер для 1С:Предприятия 8.3
  (УТ/Бухгалтерия/ERP) с транспортом `GET /sse` + `POST /messages` и
  диагностикой `GET /health`. Авторизация контейнеров — `MCP_AUTH_TOKEN`;
  per-request креды — `X-1C-OData-Url`, `X-1C-Username`, `X-1C-Password` с
  fallback на `ONEC_*`. URL валидируется как `http(s)://…/odata/standard.odata`
  без userinfo/query; Basic-авторизация и `Accept: application/json`;
  повтор до двух попыток на 429/5xx, секреты не попадают в логи и ошибки.
- Инструменты: `1c_nomenclature_list`, `1c_stock_balance`,
  `1c_counterparty_debt`, `1c_customer_order_create` (треки H/J/K/L).
  Добавлены Dockerfile, 10 тестов на `node:test`, сервис `1c-mcp` на порту
  5005 в `docker-compose.mcp.yml` с healthcheck и `ONEC_MCP_URL` в API.
- Обновлены `.env.example`, `docs/architecture/MCP-ERP-Connectors.md` и
  `GETSTARTED.md` (публикация OData в 1С и подключение к SkillWharf);
  `CONNECT-32.1` отмечен `[x]` в `ROADMAP-V2.md`.

**Web UI: карточка 1С и вебхук-тригеры в `/app/settings` (WEB-32.3).**

- `src/lib/integrations.ts`: добавлен провайдер `'1c'` в
  `KEY_INTEGRATION_PROVIDERS`, схема `oneCIntegrationSchema` и поле `oneC`
  в `integrationsSchema` (по умолчанию `disconnected`). Zod-контракт
  подключения: `oneCOdataUrlSchema` (абсолютный `http://`/`https://` URL),
  `oneCUsernameSchema` и `oneCPasswordSchema` (непустые строки),
  `oneCCredentialsSchema`. Клиент `connectKeyIntegration` отправляет
  `POST /integrations/1c` с `{ odataUrl, username, password }`,
  `disconnectKeyIntegration('1c')` — `DELETE /integrations/1c`. Операции
  `1cConnect`/`1cDisconnect` добавлены в маппинг ошибок; отказ провайдера
  показывает ключ `settings.integrations.oneC.credentialsRejected`.
- `src/components/IntegrationIcon.tsx`: текстовый бейдж `1C` для новой
  карточки.
- `src/components/IntegrationsSection.tsx`: карточка «1С:Предприятие» с
  полями OData URL, логин и пароль. Пароль использует `SecretField` с
  маскировкой, кнопки «Подключить»/«Отключить», статус, локализованные
  ошибки валидации и ответа API. Универсальный `ProviderKeyCard` сужен до
  провайдеров с одним секретом (`SimpleKeyProvider`).
- `src/lib/triggers.ts` (новый): Zod-контракт триггеров (`triggerSchema`,
  `triggerListSchema`, `createTriggerInputSchema`, `createdTriggerSchema`),
  клиенты `fetchTriggers`/`createTrigger`/`deleteTrigger` для
  `/api/v1/triggers`, хелпер `getTriggerWebhookUrl(slug, origin)` для адреса
  `/api/v1/webhooks/triggers/:slug` и категории ошибок
  `getTriggerErrorKind`. Кэш TanStack Query разделён по `userId`.
- `src/components/TriggersSection.tsx` (новый): секция «Вебхук-триггеры
  (Автозапуск агентов)» на `/app/settings` рядом с интеграциями. Форма
  создания (название, источник Битрикс24/МойСклад/1С/свой вебхук, шаблон
  промпта с `{{payload}}`), карточка с готовым Webhook URL и секретом
  `X-Trigger-Secret` (маскировка, «Показать/Скрыть», «Скопировать»), список
  активных триггеров со счётчиком срабатываний и удалением.
- RU/EN-ключи `settings.integrations.oneC.*` и `settings.triggers.*` в
  `src/locales/{ru,en}.json`; обновлено описание группы внешних сервисов.
- Unit-тесты Zod-схем 1С и триггеров, клиентов и маппинга ошибок в
  `src/lib/integrations.test.ts` и `src/lib/triggers.test.ts`.

UI сверен с API-контрактом (`onec: { status, odataUrl?, source?, error? }`) и
устойчив к отсутствию эндпоинтов (404) — показывается локализованное
сообщение. Все задачи Sprint 32 (`CONNECT-32.1`, `CONNECT-32.2`, `WEB-32.3`)
завершены.

### Sprint 31: мульти-тенантность, команды и хотфикс DI (KI-086/088)

**Хотфикс KI-088 (DI-контейнер).**

- `MetricsService`: конструктор принимал `env: NodeJS.ProcessEnv = process.env`
  без DI-декораторов — Nest resolver видел `design:paramtypes = [Object]` и
  падал с `UnknownDependenciesException` при старте контейнера. Добавлены токен
  `METRICS_ENV`, провайдер `useValue: process.env` в `MetricsModule` и
  `@Optional() @Inject(METRICS_ENV)` в конструкторе.
- `SkillSignatureService`: тот же примитивный `env` помечен `@Optional()` как
  профилактика следующей DI-ошибки старта.
- Тест `Test.createTestingModule({ imports: [MetricsModule] }).compile()` +
  `moduleRef.get(MetricsService)` и переопределение `METRICS_ENV` — теперь
  DI-проблемы ловятся в `pnpm test`, а не в CI smoke-запуске.

**Бэкенд (ORG-31.1 / ORG-31.2 / ORG-31.3).**

- Модели `Organization`, `Workspace`, `WorkspaceMember` + миграция; `InstalledSkill`
  получил nullable `userId`/`workspaceId` и составной уникальный ключ
  `(name, userId, workspaceId)` (полное закрытие KI-086).
- `AuthService.register` создаёт дефолтные organization/workspace с ролью
  `owner`; для существующих пользователей структура инициализируется лениво
  при первом запросе к `/workspaces`.
- `WorkspacesController` (`/api/v1/workspaces`): список воркспейсов с ролью и
  лимитом HITL, создание воркспейса, управление участниками по email
  (роли `admin`/`operator`/`viewer` и `hitlApprovalLimitRub`).
- `WorkspaceContextGuard` читает `X-Workspace-Id`, проверяет членство и
  откатывается на дефолтный воркспейс. `viewer` не может запускать платные
  инструменты и одобрять HITL (`403 errors.insufficient_workspace_role`);
  превышение суммы одобрения — `403 errors.hitl_limit_exceeded`.
- `MarketplaceService` пишет `userId`/`workspaceId` в `InstalledSkill` и
  вычисляет `installed` строго для текущего пользователя/воркспейса.
- Тесты: автосоздание дефолтной структуры, управление участниками, запреты
  для viewer, ABAC-лимит, изоляция `installed` между пользователями.
  `pnpm test` — 1533 теста.

**Web UI (WEB-31.4).**

- `src/lib/workspaces.ts`: Zod-схемы `workspaceSchema`, `workspaceMemberSchema`,
  роли `owner/admin/operator/viewer`, лимит HITL в форматах число/строка/`null`;
  клиенты `fetchWorkspaces`, `createWorkspace`, `fetchWorkspaceMembers`,
  `addWorkspaceMember`, `updateWorkspaceMember`, ключ i18n для ошибок
  `errors.insufficient_workspace_role` и `errors.hitl_limit_exceeded`.
- `api.ts` добавляет `X-Workspace-Id` из активного воркспейса во все запросы;
  `store/workspace.store.ts` сохраняет выбор в localStorage. При смене
  воркспейса инвалидируются кэши чатов, навыков, маркетплейса и интеграций.
- `WorkspaceSwitcher` в сайдбаре и на странице команды: компактный селектор с
  названием и ролью, создание воркспейса через `<dialog>`.
- Новая защищённая страница `/app/team` с таблицей участников, ролями,
  лимитом автоодобрения HITL и формой добавления (owner/admin); пункт
  «Команда» / `Team` добавлен в навигацию. RU/EN-ключи и unit-тесты.

### Sprint 30: Multi-Agent Supervisor, Semantic Cache и дашборд Evals/Cache

**GRAPH-30.1 / CACHE-30.1 / CACHE-30.2 (бэкенд и worker).**

- `GRAPH-30.1`: контракты `orchestrationMode` (`single` по умолчанию),
  `agentRoles` и `traceId`; новый узел `supervisor` в графе llm-worker
  детерминированно выбирает профильную роль (`researcher`/`drafter`/
  `reviewer`/`analyst`/`operator`), публикует `agent_handoff` с единым
  `traceId` и ограничивает число передач `MULTI_AGENT_MAX_HANDOFFS` (default 4).
  API включает supervisor-режим при двух и более ролевых навыках.
- `CACHE-30.1/30.2`: `SemanticCacheService` в `apps/api/src/llm/` — Redis с TTL
  `SEMANTIC_CACHE_TTL_SECONDS`, косинусное сходство эмбеддингов с порогом
  `SEMANTIC_CACHE_THRESHOLD` (default 0.95). Ключ строго изолирован по
  `userId`/`promptVersionId`/`model`; запросы с инструментами не кешируются.
  Попадание отдаёт `cacheHit:true` без вызова LLM и без списания в BAL/Ledger.
  Метрики `skillwharf_semantic_cache_hits_total` / `_misses_total`.
- Тесты: 5 тестов supervisor-графа (включая лимит передач и traceId), 5 тестов
  кеша (изоляция, порог 0.95, bypass инструментов), 3 теста ChatService
  (cacheHit без списания). `pnpm test` — 1510 тестов.

**WEB-30.3 (Web UI).**

- `src/lib/office-events.ts`: Zod-схема `officeHandoffSchema` и поддержка
  `office_event` с типом `agent_handoff` (`fromRole`, `toRole`, `reason`), включая
  payload без явного `type`. Обычный `office_event` по-прежнему валидируется
  Zod и не меняет поведение.
- `store/office.store.ts` хранит до 8 последних передач с `conversationId` и
  временем получения; `OfficePage` показывает компактную ленту и подсвечивает
  карточки ролей `fromRole`/`toRole` (бейджи «Передаёт» / «Принимает»).
- `src/lib/message-metadata.ts`: `assistantMessageMetadataSchema` с
  необязательным `cacheHit`. Метаданные читаются из ack и `stream_end`,
  присоединяются к сообщению ассистента; при `cacheHit: true` в ленте чата
  показывается бейдж «Из кеша · 0 ₽» / «Cached · 0 ₽» с tooltip про
  семантический кеш без расхода токенов.
- RU/EN-ключи и unit-тесты парсинга handoff, стора и `cacheHit`.

**Инфраструктура и наблюдаемость (EVAL-29.4).**

- `infra/monitoring/grafana/provisioning/dashboards/evals-and-cache.json`: новый
  дашборд `SkillWharf Evals & Cache` (UID `skillwharf-evals-cache`) с панелями
  Eval Pass Rate (`skillwharf_eval_pass_rate`), среднего балла LLM-as-a-Judge
  (`skillwharf_eval_avg_score`), Hit Rate и сэкономленных токенов
  семантического кеша (`skillwharf_semantic_cache_*_total`,
  `skillwharf_semantic_cache_tokens_saved_total`) и мультиагентных handoff'ов
  (`skillwharf_agent_handoffs_total`). Подключён вторым file-провайдером в
  `dashboards.yml`.
- `.env.example` и `docker-compose.yml`: добавлены `SEMANTIC_CACHE_ENABLED`
  (по умолчанию `false`), `SEMANTIC_CACHE_THRESHOLD` (`0.95`),
  `SEMANTIC_CACHE_TTL_SECONDS` (`3600`) и `MULTI_AGENT_MAX_HANDOFFS` (`4`) —
  проброшены в `api` и `llm-worker`.
- Runbook дополнен разделом 23 про включение кеша, порог сходства и защиту
  графа Supervisor от зацикливания. `EVAL-29.4` отмечена `[x]` в `ROADMAP-V2.md`.

### Sprint 29: Golden Datasets, LLM-as-a-Judge и Evals в Control Plane

**EVAL-29.1 (датасеты и CLI).**

- `evals/datasets/`: добавлены 12 золотых датасетов `track-a.json` …
  `track-l.json` с 36 реалистичными кейсами (по 3 на трек `A–L`) в едином
  контракте (`id`, `trackId`, `title`, `input`, `expectedTools`,
  `requiresHitl`, `rubric.required`/`rubric.forbidden`) и реестр `index.json`.
- `scripts/run-evals.mjs`: CLI валидации структуры датасетов и прогона через
  `POST /api/v1/prompts/:id/evals/run` (promptId в path, `versionId` в теле;
  рубрика приводится к плоскому массиву как в `datasetRubricSchema`), разбор
  ответа `EvalRunView` (`caseId`, `verdict.passed`/`reasoning`), сводная таблица
  Pass/Fail по трекам; exit code 1 при pass rate ниже `EVALS_MIN_PASS_RATE`
  (по умолчанию 0.85). Добавлены npm-скрипт `pnpm evals:validate` и шаг
  валидации в CI. Гайд — `docs/development/LLM-Evals-Guide.md`.

**EVAL-29.2 / EVAL-29.3 (бэкенд и гейт промоушена).**

- Модель `PromptEvalRun` + миграция (`promptId`, `versionId`, `trackFilter`,
  `totalCases`/`passedCases`, `passRate`, `avgScore`, `status`, `resultsJson`,
  `completedAt`) и история прогонов через `GET /api/v1/prompts/:id/evals`.
- `prompt-eval.schemas.ts`: Zod-схемы `evalCaseSchema`, `judgeVerdictSchema`
  (score 0..100, passed, reasoning), датасетов `evals/datasets/track-*.json`
  с приведением рубрики `required`/`forbidden` к массиву, валидация тела
  `POST /api/v1/prompts/:id/evals/run`.
- `PromptEvalsService`: детерминированная проверка `tool_calls` и `requiresHitl`
  по трассировке кейса + LLM-судья (`LlmJudgeClient` через `LlmRouterService`,
  строгий системный промпт и JSON-парсинг ответа) с детерминированным
  mock-судьёй для dev/тестов. Статус `passed` при `passRate >=
  EVALS_MIN_PASS_RATE` (default 0.85), иначе `failed`.
- Гейт промоушена (EVAL-29.3): `stopPromptExperiment` при
  `EVALS_GATE_PROMOTION=true` или явном `requirePassingEval` отклоняет
  промоушен без успешного Eval-прогона версии — `400 errors.eval_gate_failed`.
- Тесты: 5 тестов Zod-схем и датасетов, 5 тестов расчёта passRate и статусов
  (включая mock-судью и кастомный порог), 4 теста гейта промоушена.
  `pnpm test` — 1483 теста.

**WEB-29.5 (панель в Control Plane).**

- Добавлена панель «Автооценка качества (LLM Evals)» в drawer версий шаблона
  на `/admin`: выбор версии и опционального трека A–L, кнопка «Запустить Eval»
  с индикатором, история прогонов со статусом, процентом прохождения,
  средним баллом (`avgScore / 100`) и раскрываемой детализацией кейсов с
  обоснованием судьи для проваленных случаев.
- `src/lib/admin.ts`: Zod-схемы `promptEvalCaseResultSchema`,
  `promptEvalRunSchema`, списка прогонов и формы запуска; клиенты
  `fetchPromptEvals` (`GET /prompts/:id/evals`) и `runPromptEval`
  (`POST /prompts/:id/evals/run`), ключ кэша `promptEvals`.
- При повышении версии B в A/B-эксперименте ошибка `errors.eval_gate_failed`
  теперь читается из machine-readable поля `code` ответа API и показывается
  локализованным сообщением об ошибке (а не зелёным уведомлением); добавлен
  подсказочный текст про обязательный Eval перед промоушеном.
- RU/EN-ключи и unit-тесты контракта, клиента и перевода ошибки гейта.

### Планирование: дорожная карта Post-GA

- Добавлен `docs/development/ROADMAP-V2.md`: 4 стратегических этапа
  (`v1.1.0` — `v2.0.0`) и 8 спринтов (29–36) с уникальными ID задач и
  чекбоксами для агентов. План покрывает LLM Evals и LLM-as-a-Judge,
  многоагентную оркестрацию LangGraph и семантический кеш, Organizations/
  Workspace и granular RBAC, MCP-коннектор 1С и event-driven webhooks,
  Transactional Outbox с платформенным кошельком (остаток KI-087), KMS/Vault
  (остаток KI-053) и HA-нагрузочное тестирование, No-Code конструктор и
  Developer Portal с аудитом навыков. Базой служит релиз `v1.0.0-ga`.
  Ссылка добавлена в `docs/README.md`.

### Маркетинг: питч-дек под релиз v1.0.0-ga

- `docs/marketing/pitch/create_pitch.py`: короткий питч переработан с трёх
  слайдов раннего пилота на шесть слайдов актуального релиза: статус
  `v1.0.0-ga (Production Ready)` и демо 12 отраслей на `skillwharf.ru`,
  12 треков `A–L` с Оптом `K` и Производством `L` и интеграциями
  Битрикс24/МойСклад, Marketplace с подписью Ed25519 и Revenue Share 85/15,
  изоляция Docker/Firecracker/gVisor, SNI Egress-прокси и ротация ключей,
  Control Plane v2 с A/B-тестированием промптов и память pgvector/Qdrant.
  Скрипт теперь сохраняет `.pptx` рядом с собой и запускается из любого
  каталога; `SkillWharf_Pitch.pptx` пересобран.
- `docs/marketing/pitch/README.md`: статус релиза, описание шести слайдов и
  инструкция пересборки; расширенные питч-материалы помечены как исторические
  артефакты пилота.

## [1.0.0-ga] - 2026-11-19

Финальный релиз дорожной карты: этапы 0–3 завершены. Self-hosted платформа
с изолированными навыками, биллингом, открытым маркетплейсом и масштабируемой
векторной памятью. Тег релиза создаёт Владелец продукта.

### Sprint 28: A/B-эксперименты, per-model тарифы, память и Qdrant

**Backend (API-28.1 / API-28.2 / INFRA-28.3).**

- `API-28.1` (KI-009): модель `PromptExperiment` и миграция; эндпоинты
  `GET/POST /prompts/:id/experiments` и `POST /prompts/experiments/:expId/stop`
  для admin/owner с Zod-валидацией и запретом двух `running`-экспериментов на
  промпт. `PromptsService.resolveSystemPrompt` выбирает вариант по SHA-256
  хешу `conversationId` (один диалог — одна версия); `metricsJson` хранит
  запросы, суммарную latency и стоимость, а список отдаёт средние значения
  `avgLatencyMs`/`avgCost`. Остановка поддерживает промоушен победителя;
  действия пишутся в AuditLog.
- `API-28.2` (KI-040): `LLM_MODEL_PRICING_JSON` и поля `LlmRoute`
  `inputCostPer1k`/`outputCostPer1k` с fallback на `LLM_COST_PER_1K_TOKENS`.
  `calculateModelCost` считает input/output раздельно; `LlmBudgetService`
  использует ту же стоимость в Ledger, OTel и `llm_cost_total`. Флаг
  `METRICS_HASH_TENANT_ID` (по умолчанию включён в production) заменяет
  `tenant_id` на короткий хеш против взрыва кардинальности.
- `INFRA-28.3` (KI-024): `MemoryChunk` получил `source`, `kind` (default
  `fact`) и `updatedAt`; `GET /api/v1/chat/memory` отдаёт новые поля.
  Выделен `IVectorMemoryStore`: `PgVectorMemoryStore` по умолчанию и
  `QdrantVectorStore` при `VECTOR_STORE_PROVIDER=qdrant` (HTTP API Qdrant через
  `fetch`, фильтр по userId и валидация ответов через Zod).
- Тесты: 6 тестов A/B (распределение, метрики, stop/promote, Zod), 5 тестов
  per-model тарифов, 3 теста Qdrant с mock HTTP, обновлённые тесты памяти с
  новыми полями. `pnpm test` — 1457 тестов.

**Web UI (WEB-28.1, KI-009/KI-024).**

- `WEB-28.1` (KI-009): в drawer'е версий шаблона Control Plane добавлен блок
  «A/B-тестирование версий». Клиент (`src/lib/admin.ts`) валидирует Zod-схемы
  списка/создания/остановки экспериментов и поддерживает запросы
  `GET/POST /prompts/:id/experiments` и
  `POST /prompts/experiments/:expId/stop`. Форма выбирает версии A/B и долю
  трафика B (10–90%), карточка показывает статус, распределение и сравнение
  вызовов, задержки и стоимости, а также кнопки остановки и повышения версии B.
  При 404/501 показывается локализованное сообщение о недоступности API.
- UI-часть KI-024: схема `src/lib/rag-memory.ts` принимает необязательные
  `kind`, `source` и `updatedAt` при полной обратной совместимости со старым
  ответом; `RagMemoryPanel` показывает бейдж типа, источник и дату обновления,
  заглушка «метаданные появятся позже» удалена. RU/EN-ключи и unit-тесты
  обновлены.

**Инфраструктура (INFRA-28.3, ADR 0002).**

- `INFRA-28.3` (ADR 0002): в `docker-compose.yml` добавлен сервис `qdrant`
  (`qdrant/qdrant:v1.12.4`) в профиле `qdrant`: постоянный том
  `qdrant_data:/qdrant/storage`, healthcheck `GET /readyz`, без публикации
  портов 6333/6334 в базовом стеке. По умолчанию стек остаётся лёгким на
  pgvector. В `docker-compose.staging.yml` порт 6333 открыт только на
  `127.0.0.1` для отладки и импорта коллекций.
- В `api` проброшены `VECTOR_STORE_PROVIDER` (по умолчанию `pgvector`),
  `QDRANT_URL` (`http://qdrant:6333`), `QDRANT_API_KEY` и
  `QDRANT_COLLECTION` (`skillwharf_memory`); все переменные документированы
  в `.env.example`.
- В `docs/operations/Deployment-Runbook.md` добавлен раздел 22 с порядком
  запуска `--profile qdrant`, проверкой и процедурой отката на pgvector.
  `INFRA-28.3` отмечен `[x]` в Roadmap.

### Sprint 27: Ed25519-подписи, публичный реестр, Revenue Share и витрина

**API-27.1 / API-27.2 (backend, подписи и монетизация).**

- `API-27.1`: в `packages/shared` добавлены поля `signature`
  (`ed25519:<base64>`) и `publicKeyId` (`[a-z0-9-]{1,64}`) в
  `SkillManifestSchema` и модуль `skill-signing.ts` — Ed25519 на `node:crypto`,
  каноническая сериализация (рекурсивная сортировка ключей, `body` отдельным
  полем, `signature`/`publicKeyId` исключаются), генерация пары, подпись и
  верификация. CLI: `pnpm --filter api skill:keygen` и
  `pnpm --filter api skill:sign <SKILL.md>`. `SkillSignatureService`
  проверяет подпись при публикации/установке по реестру
  `TRUSTED_SKILL_PUBLIC_KEYS` (JSON или CSV), политика
  `REQUIRE_SIGNED_SKILLS=true` отклоняет неподписанные навыки (по умолчанию
  выключена). Ошибка — `400 errors.invalid_skill_signature`.
- `API-27.2`: модель `MarketplaceSkill` + миграция, публичный
  `MarketplaceController` (`GET /marketplace/skills` с фильтрами `track`
  A–L / `pricingModel` / `verified` / `search` и пагинацией, `POST` публикации,
  `POST /:slug/install` с инкрементом `downloadsCount` в транзакции).
  `InstalledSkill.marketplaceSlug` связывает установку с каталогом.
- Revenue Share 85/15: `BillingService.chargeForMarketplaceSkill` и
  `recordRevenueShare` пишут в одной транзакции debit покупателя,
  `author_revenue_share` (85%) и `platform_fee` (15%); сплит считается в
  копейках, сумма всегда равна цене. `RevenueShareService` после коммита
  создаёт перевод ЮKassa `POST /v3/transfers`, если у автора задан
  `payoutAccountId`; сплит подключается к Pay-per-Call/Pay-per-Outcome в
  `AgentRuntimeService`.
- Тесты: 5 тестов Ed25519 (включая подмену 1 символа в `SKILL.md`), 5 тестов
  `SkillSignatureService`, 4 теста каталога (фильтры A–L, установка в 1 клик),
  10 тестов сплита и BAL-проводок. Полный прогон `pnpm test` — 1422 теста.
- KI-086: ответ `GET /api/v1/marketplace/skills` обогащён до контракта витрины
  (`marketplaceSkillViewSchema`): `permissions` из `manifestYaml` (при ошибке
  парсинга — `[]`), объект `signature` с `verified`/`status`/`publicKeyId`,
  плоский `publicKeyId` и `installed` из `InstalledSkill`. Метод сервиса
  переименован в `listSkills(query, userId)`, контроллер передаёт userId из
  JWT. Флаг «Установлено» теперь берётся из БД и сохраняется после F5.
  4 новых теста контракта. Per-user фильтрация `installed` требует миграции
  `InstalledSkill` (зафиксировано в KI-086).

**WEB-27.3 (витрина `/app/marketplace`).**

- Добавлен защищённый маршрут `/app/marketplace` и пункт «Маркетплейс» /
  `Marketplace` в боковую и верхнюю навигацию приложения рядом с «Навыками».
- `src/lib/marketplace.ts`: Zod-контракты карточки, ответа списка и ответа
  установки; `fetchMarketplaceSkills(filters)` отправляет только заполненные
  query-параметры (поиск, трек A–L, модель оплаты, `verified`), а
  `installMarketplaceSkill(slug)` устанавливает навык в 1 клик. Все ответы
  валидируются, при 404/501 показывается локализованное сообщение о том, что
  раздел ещё недоступен; сетевые ошибки, 401/403 и невалидные ответы
  различаются по коду `MarketplaceError`.
- Витрина: поиск с debounce 300 мс, чипсы 12 треков, фильтр по цене, чекбокс
  Ed25519, сетка карточек с бейджем проверки, ценой и счётчиком установок,
  установка с toast и окно «Подробнее о навыке» (описание, разрешения, статус
  подписи). RU/EN-ключи добавлены в оба словаря; оформление использует токены
  Material 3 и работает в тёмной теме.
- Unit-тесты `src/lib/marketplace.test.ts`: валидация списка и бейджа
  `verified`, фильтрация query-параметров, деградация 404/501 и ошибки
  установки. Первоначальный разрыв контракта (API не отдавал
  `permissions`/`signature`/`installed`) закрыт в API-27.2 — см. KI-086.

### Sprint 26: Internal JWT, keyId rotation, OIDC, Tempo и защита бэкапов

**SEC-26.1 / SEC-26.2 (internal JWT и ротация ключей).**

- `SEC-26.1` (KI-045): общий модуль `packages/shared/src/internal-jwt.ts`
  выпускает и проверяет HMAC-SHA256 JWT на 60 секунд с `iss`
  (`skillwharf-api`/`skillwharf-worker`), `aud` (`internal-worker`/
  `internal-api`), `jti` (UUID), `iat`/`exp`. `LlmWorkerClient` и
  `InternalApiClient` передают JWT в `x-internal-token`; `InternalTokenGuard`
  (API) и `InternalJwtGuard` (llm-worker) проверяют направление, срок жизни и
  подпись constant-time. Статический `INTERNAL_API_TOKEN` принимается только с
  `ALLOW_LEGACY_INTERNAL_TOKEN=true` вне production. В `NODE_ENV=production`
  пустой/короткий (<32) секрет завершает старт api и llm-worker (fail closed).
- `SEC-26.2` (KI-053): envelope `v2:<keyId>:<iv>:<tag>:<ciphertext>` с
  `TOKEN_ENCRYPTION_KEY_ID` (default `local-v1`). Чтение старого `v1` и v2 с
  previous keys из `TOKEN_ENCRYPTION_PREVIOUS_KEYS` (JSON или CSV). Добавлен
  `CredentialRotationService.rotateAllCredentials()` — атомарная перешифровка
  `ProviderCredential`, `GoogleCredential`, `TelegramBot` в транзакции Prisma —
  и CLI `pnpm --filter api keys:rotate`. Облачный KMS не подключён
  (`KeyManagementService` остаётся точкой расширения).
- Тесты: 9 тестов внутреннего JWT (аудитория, `exp`, подпись, издатель,
  fail-closed, legacy), 4 теста guard API, обновлённые тесты cipher и rotation
  (v1 → v2, previous keys, rollback). Полный прогон `pnpm test` — 1386 тестов.

**INFRA-26.3 (OIDC и трейсы).**

- Опциональный OIDC/OAuth2 для Grafana: `GRAFANA_OIDC_*` маппятся в
  `GF_AUTH_GENERIC_OAUTH_*` в `docker-compose.yml` и
  `docker-compose.staging.yml`. Пока `GRAFANA_OIDC_ENABLED` не задан,
  работает только Basic Auth (fallback); при включённом OIDC Basic
  остаётся, пока `GRAFANA_BASIC_AUTH_ENABLED` не выставлен в `false`.
  Entrypoint Grafana проверяет обязательные OIDC-параметры. Prometheus
  остаётся за Caddy Basic Auth (нативного OIDC нет).
- Добавлен сервис `tempo` (`grafana/tempo`) в профиль `monitoring` с томом
  `tempo_data`, retention `168h` (7 дней) и OTLP-приёмниками в
  `infra/tempo/tempo-config.yaml`. OTel Collector шлёт спаны в `tempo:4317`
  через новый экспортёр `otlp/tempo` в дополнение к `debug`; в Grafana
  провижинен datasource `Tempo` (`infra/monitoring/grafana/provisioning/datasources/tempo.yml`).

**INFRA-26.4 (шифрование и изолированный drill).**

- `scripts/upload-backup.sh`: при `BACKUP_ENCRYPTION_KEY` дамп шифруется
  `openssl enc -aes-256-cbc -pbkdf2 -iter 100000` (ключ через env), в S3
  уходит `.enc`; для всех объектов включён SSE-S3 `AES256`, пишется
  `.sha256`-сайдкар и после выгрузки объект скачивается повторно для сверки
  SHA-256. Ротация в `scripts/lib/backup-s3.sh` покрывает `.dump*`.
- `scripts/restore-drill.sh`: восстановление перенесено в изолированный
  контейнер с `--network none` вместо боевого инстанса (по умолчанию
  `pgvector/pgvector:pg17` — боевые дампы содержат расширение `vector`).
  Дамп проверяется по SHA-256, расшифровывается, восстанавливается через
  `pg_restore` и проверяет `User`, `LedgerEntry` и append-only-триггеры
  `prevent_update_ledger`/`prevent_delete_ledger`; контейнер и temp-файлы
  удаляются по `trap EXIT`.
- Стыковка env: `TOKEN_ENCRYPTION_PREVIOUS_KEYS` проброшен в контейнер `api`
  для CLI `pnpm --filter api keys:rotate`.

Обновлены `.env.example`, Runbook и статусы KI-018/KI-035/KI-036/KI-038/KI-045/KI-053.

### Sprint 25: Hardware Sandbox, egress proxy, Kubernetes и E2E HITL/Ledger

**INFRA-25.1 / SEC-25.3 (sandbox-worker).**

- `INFRA-25.1`: в `apps/sandbox-worker` выделен интерфейс
  `ISandboxRuntimeProvider` (`execute`/`healthCheck`). Логика запуска
  контейнеров перенесена в `DockerSandboxProvider` без изменения поведения:
  при отсутствии `SANDBOX_RUNTIME` или `SANDBOX_RUNTIME=docker` сеть без
  allowlist остаётся `none`, UID 65534, те же seccomp/лимиты/таймаут.
  `FirecrackerSandboxProvider` создаётся только при явном
  `SANDBOX_RUNTIME=firecracker`: конфигурация (KVM + `FIRECRACKER_BIN`,
  kernel/rootfs, vCPU/MiB) валидируется Zod, отсутствие `/dev/kvm` или
  бинарника завершает старт воркера (fail closed, без фолбэка на Docker).
  MicroVM настраивается через API socket: `boot-source`, read-only `drives`
  (rootfs + код), `machine-config`, `actions/InstanceStart`, с таймаутом.
- `SEC-25.3` (KI-028, KI-042): новый модуль `egress-proxy.ts` извлекает SNI из
  TLS ClientHello и `Host` из HTTP, требует точного совпадения с
  `egressAllowlist`, резолвит FQDN и блокирует приватные/loopback/link-local/
  metadata диапазоны (включая `169.254.169.254`, `127.0.0.1`, `::1`), а также
  IPv4-mapped адреса. `EgressForwardProxy` содержит CONNECT/HTTP-хендлеры с
  подключением к проверенному IP. `DockerSandboxProvider` вызывает guard при
  наличии allowlist до создания контейнера (без allowlist сеть по-прежнему
  `none`); при явно заданном `SANDBOX_EGRESS_PROXY_URL` инжектируются proxy-env.
  В `.env.example` добавлены закомментированные переменные рантайма и прокси.
- Тесты: 110 unit-тестов `sandbox-worker` (дефолтный выбор провайдера,
  активация Firecracker и fail-closed без KVM, парсер ClientHello, чужой
  SNI/Host в CONNECT и в авторизации, DNS rebinding в провайдере). Полный
  прогон `pnpm test` — 1366 тестов.

**QA-24.4 (сквозной E2E Chat → HITL → Ledger, KI-049).**

- Добавлен контрактный E2E `apps/api/test/agent-hitl-billing.e2e-spec.ts`:
  настоящие `ChatController`/`ChatService`, `AgentRuntimeService`,
  `PendingApprovalService` и `BillingService`, in-memory Prisma
  (`apps/api/test/support/fake-agent-prisma.ts`) с escrow-операциями,
  `Decimal` и rollback `$transaction`, а также mock LLM-worker, повторяющий
  контракт `apps/llm-worker/src/agent/graph.ts` (`prepareApproval` →
  interrupt, `resolveApproval` → `executeTools`).
- Покрыты approve (hold `PENDING` 100 ₽ → `debit`, `GET /api/v1/chat/pending`
  с `expiresAt`, финальный ответ и история), reject (`cancelHold`, `credit`,
  баланс `500.00 ₽`), ошибка инструмента после approve (возврат средств) и
  повторный approve без второго списания.
- Тест включён в общий прогон `pnpm test` (корневой `vitest.config.ts`);
  внешние LLM/MCP/Sandbox не требуются. KI-049 переведён в «Исправлено».

**INFRA-25.2 (Kubernetes gVisor и Job миграций).**

- `INFRA-25.2`: добавлены базовые production-манифесты в `deploy/k8s/`: `RuntimeClass gvisor` (`handler: runsc`), `Job db-migrate` (`prisma migrate deploy`, `backoffLimit: 3`, без параллельных реплик), `Deployment sandbox-worker` (`runtimeClassName: gvisor`, read-only rootfs, `capabilities.drop: ALL`) и `NetworkPolicy` с запретом прямого egress для `api`, `llm-worker`, `sandbox-worker` (разрешены DNS и `egress-proxy`).
- Добавлен гайд `docs/operations/KUBERNETES-DEPLOY.md` с порядком применения манифестов, проверкой gVisor и описанием egress-прокси; ссылка добавлена в `docs/README.md`. KI-037 переведён в «Исправлено».

### Sprint 24: per-user MCP, маппинг контрагента и Pay-per-Call Hold → Capture

- `MCP-24.1`: `MarketplaceMcpService` читает ключи пользователя из
  `ProviderKeysService` (`bitrix24`, `moysklad`, `ozon`, `wb`) с fallback на
  env и передаёт их в `McpClient` заголовками `X-Bitrix24-Webhook-Url`,
  `X-Moysklad-Token`, `X-Ozon-Client-Id`, `X-Ozon-Api-Key`,
  `X-Wb-Api-Token`. Клиент кешируется по endpoint + отпечатку кредов, поэтому
  разные пользователи не делят SSE-сессию; значения заголовков не логируются.
  Проверка «нужны env-ключи контейнера» снята: при наличии per-user ключей
  вызов идёт без env API. MCP-серверы Битрикс24/МойСклад читают заголовки из
  SSE-сессии и используют их вместо env.
- `MCP-24.1` (infra): `bitrix24-mcp` валидирует `X-Bitrix24-Webhook-Url`
  (`https://*.bitrix24.ru/rest/...` или локальные тесты) и возвращает 400 на
  некорректное значение; `moysklad-mcp` читает `X-Moysklad-Token` и подставляет
  его в `Authorization: Bearer`. Оба сервера поддерживают заголовок и на
  `POST /messages`, не логируют значения кредов и сохраняют fallback на env.
  `docker-compose.mcp.yml` по умолчанию ставит `MCP_ALLOW_MISSING_KEYS=1`.
- `MCP-24.2`: `moysklad-mcp` добавил `demand_create`, `purchase_order_create`,
  `counterparty_balance`, `bundle_get` в `tools/list`; списочные methods
  поддерживают `limit`/`offset`, запросы к JSON API 1.2 повторяются до двух
  попыток с экспоненциальным backoff на 429/5xx и сетевых сбоях. Добавлены
  юнит-тесты MCP-серверов (`node --test`) на заголовки и новые методы.
- `API-24.3`: `moysklad_create_order` запрашивает сделку через `crm_deal_get`,
  получает название компании (`COMPANY_ID` → `crm_company_list`) или
  `TITLE`, ищет точное совпадение в `counterparty_list` МойСклада и
  подставляет найденный `id` в `agent`. Если контрагент не найден — fallback
  на `MOYSKLAD_DEFAULT_AGENT_ID`; если нет ни того, ни другого — 503
  `errors.provider_not_configured`. В ответ добавлен `counterpartySource`.
- `BILLING-24.5`: Pay-per-Call переведён на двухфазную схему. До вызова
  инструмента `authorizeHold` резервирует сумму (`heldBalance`, PENDING,
  детерминированный ключ `paypercall:<conversationId>:<callId>`), при нехватке
  средств — 402 `errors.insufficient_funds` до внешнего API/MCP/Sandbox. После
  успеха — `captureHold` (PENDING → debit), при ошибке — `cancelHold`.
  Freemium-вызовы остаются с постоплатой после успеха.
- `REGISTRATION_MODE` валидируется Zod-`enum` при старте `AuthService`:
  опечатка роняет запуск; значение, изменённое после старта, трактуется как
  `closed`.
- Тесты: заголовки per-user кредов в `McpClient` (SSE и POST), приоритет
  кредов БД над env, маппинг контрагента и fallback в `moysklad_create_order`,
  откат hold при ошибке и 402 до вызова, Zod-валидация режима регистрации.

### Web: превью AI-Офиса для 12 треков и заявка Design Partner (WEB-24.6)

- На лендинге (`apps/web/src/pages/LandingPage.tsx`) появился интерактивный
  блок «Попробуйте AI-Офис в действии (12 отраслей)»
  (`src/components/OfficeSimulator.tsx`): переключатель 12 треков A–L,
  3–5 агентов трека, шаги сценария, статусы «Работает» / «Ждёт одобрения
  (HITL)» и кнопка «Одобрить» с итоговым результатом. Симуляция — клиентская
  state machine (`src/lib/office-simulator.ts`) без запросов к API, поэтому
  блок работает на статическом `skillwharf.ru`.
- Форма «Запросить инвайт на пилот» (`src/components/DesignPartnerSection.tsx`,
  Zod-схема `src/lib/design-partner.ts`): имя/компания, контакт
  (Telegram/телефон/email), отрасль A–L, комментарий. При заданном
  `VITE_LEAD_WEBHOOK_URL` заявка уходит `POST` JSON; без вебхука или при его
  ошибке формируются `mailto:` на `VITE_CONTACT_EMAIL` и текст для
  копирования в Telegram, поэтому заявка не теряется.
- Hero-CTA «Запросить пилот» ведёт на форму, «Смотреть демо» — на симулятор;
  в навигации добавлен пункт «Демо». `VITE_LEAD_WEBHOOK_URL` описан в
  `apps/web/README.md` и `src/vite-env.d.ts`.
- Тесты: полнота 12 треков A–L и сценариев симулятора
  (`office-simulator.test.ts`), Zod-схема и fallback-логика заявки
  (`design-partner.test.ts`).

### Docs: синхронизация 12 треков, ROADMAP и staging-вебхуков

- `SPRINTS-14-PLUS.md` помечен как архив со ссылкой на актуальный `ROADMAP.md`; исправлено правило markdownlint MD041.
- В `ROADMAP.md` (Sprint 24) добавлены задачи `BILLING-24.5` (Hold -> Capture для Pay-per-Call) и `WEB-24.6` (превью-симулятор 12 треков и заявка Design Partner на `skillwharf.ru`).
- `STAGING-DEPLOY.md`: вебхук ЮKassa переведён на `https://app.skillwharf.ru/api/v1/billing/webhook`, добавлено предупреждение о недоступности вебхуков ЮKassa/Telegram при выгрузке WSL2 или перезагрузке Windows без keep-alive.
- `LANDING_CONCEPT.md` актуализирован под 12 треков A–L: добавлены OCR, финансовый аналитик маркетплейсов, оптовая торговля и производство.
- `docs/README.md`: добавлены ссылки на единый гид по 12 трекам (`ecosystem/USE-CASES-GUIDE.md`) и `architecture/MCP-ERP-Connectors.md`.

### Web: маскировка вебхука Битрикс24 и инвайт-код на регистрации (KI-076, KI-073)

- KI-076: поле `Webhook URL` в карточке Битрикс24 маскируется по умолчанию
  (`type="password"`). Рядом — кнопка-переключатель «Показать»/«Скрыть» с
  иконкой глаза, `aria-label`, `aria-pressed` и `aria-controls`; под полем —
  предупреждение «URL содержит секретный токен доступа — не показывайте его
  на демонстрациях экрана» (RU/EN). Поле вынесено в
  `apps/web/src/components/SecretField.tsx`, видимость сбрасывается после
  подключения.
- KI-073 (UI): новая страница `/register` (`RegisterPage`) с email, паролем и
  необязательным полем «Код приглашения (Invite Code)». Zod-схема
  `registerRequestSchema` (`apps/web/src/lib/registration.ts`) отправляет
  `inviteCode` в `POST /api/v1/auth/register` только непустым (после
  `.trim()`), поэтому `REGISTRATION_MODE=open` работает без кода; ссылка на
  регистрацию добавлена на `/login`.
- i18n ошибок: коды `errors.registration_closed` и
  `errors.invalid_invite_code` (RU/EN) смапплены в `chat-errors.ts` и в
  обработчике ошибок авторизации; live-проверка ключей Битрикс24/МойСклад
  показывает «Портал Битрикс24 отклонил вебхук» / «МойСклад отклонил токен»
  для 400 `errors.provider_auth_required`, а для 502
  `errors.provider_unavailable` — локализованный текст «Провайдер временно
  недоступен».
- Тесты: `SecretField.test.ts` (маскировка и переключатель),
  `registration.test.ts` (`inviteCode` только непустым, валидация формы),
  дополнения в `chat-errors.test.ts` и `integrations.test.ts` (коды ошибок и
  отказ провайдера).

**Известные проблемы:** KI-076 и KI-073 закрыты; прогон live-проверок в CI
остаётся за KI-083.

### Post-Pilot: live-проверки интеграций и invite-only конфигурация

- `scripts/test-integrations.sh` получил флаги `--bitrix24` и `--moysklad`, а также включил их в общий прогон. Битрикс24 проверяется read-only `POST ${BITRIX24_WEBHOOK_URL%/}/profile.json` с проверкой JSON-поля `result`; МойСклад — `GET /entity/organization?limit=1` с Bearer-токеном. Webhook URL, токены и тела ответов не печатаются; без ключей — `SKIP`, 401/403 — `FAIL`.
- В `.env.example` и `docker-compose.yml` добавлены `REGISTRATION_MODE` (`open|invite|closed`) и `REGISTRATION_INVITE_CODE` для пилотной invite-only регистрации. Compose по умолчанию использует `invite` (для Design Partners), `open` остаётся для dev.
- README и GETSTARTED актуализированы под 12 бизнес-треков A–L (включая Опт и Производство), добавлены ссылка на `https://skillwharf.ru`, раздел о режимах регистрации и команды проверки Битрикс24/МойСклада.
- Остаточные ограничения — KI-083 (live-проверки не запускаются в CI без секретов).

### Enterprise readiness: invite-only, live-проверка ключей и условный HITL (KI-073, KI-075, KI-079, KI-081)

- Регистрация (KI-073): `AuthService.register` учитывает `REGISTRATION_MODE`
  (`open`|`invite`|`closed`). Без переменной режим `open`, но при заданном
  `REGISTRATION_INVITE_CODE` — `invite`. `closed` отдаёт 403
  `errors.registration_closed`; `invite` сверяет `inviteCode` constant-time
  (`timingSafeEqual`) и при несовпадении/отсутствии — 403
  `errors.invalid_invite_code`. В Zod-схему и DTO добавлено
  `inviteCode: z.string().trim().min(1).max(128).optional()`; проверка режима
  идёт до обращения к БД.
- Подключение Битрикс24/МойСклада (завершение KI-075): перед сохранением
  `ProviderKeysService` выполняет live-проверку через `provider-http` с
  таймаутом 5 секунд — `GET <webhook>/profile.json` и
  `GET <MOYSKLAD_BASE_URL>/entity/organization?limit=1` с
  `Authorization: Bearer`. 401/403 → 400 `errors.provider_auth_required`,
  сеть/5xx → 502 `errors.provider_unavailable`; невалидные ключи в БД не
  пишутся. Пропуск — только при `SKIP_INTEGRATION_LIVE_CHECK=true`.
- `moysklad_check_stock` (KI-081): услуги/комплекты без `stock`/`reserve`
  возвращают `{ tracked: false, available: true, stock: null, reserve: null,
  reason: 'untracked_item' }` вместо 502. Для товаров с `article`
  запрашивается `stock_report` (`filter=article=<article>`, `limit=100`) и
  добавляется `warehouses: [{ name, stock }]`; при недоступном отчёте —
  fallback на остаток карточки. Действие `stock_report` добавлено в строгие
  схемы MCP Gateway.
- Условный HITL (KI-079): `ToolPolicy` получил `approvalRule`, а
  `GraphContext` — `approvalRules: [{ tool, arg, values }]`. Worker
  фильтрует `approvalCalls` по аргументам: `bitrix24_update_deal`
  останавливает граф только на `stageId = WON`/`*:WON`, промежуточные стадии
  и комментарии выполняются без подтверждения. Runtime-гейт
  `requiresApprovalFor` использует то же правило.
- Тесты: nock-проверки live-подключения (успех/401/403/5xx/сеть/skip), режимы
  регистрации, `tracked:false` и `warehouses` в `moysklad_check_stock`,
  условный HITL в `llm-worker`.
- Документация: `docs/KNOWN_ISSUES.md` (KI-073, KI-075, KI-079, KI-081,
  KI-082 — «Исправлено»), `.env.example`
  (`SKIP_INTEGRATION_LIVE_CHECK`).

### Integrations: ключи Битрикс24/МойСклада и обязательные поля заказа (KI-075, KI-080)

- `POST/DELETE /api/v1/integrations/bitrix24` (`{ webhookUrl }`) и
  `POST/DELETE /api/v1/integrations/moysklad` (`{ apiToken }`): секреты
  шифруются `TokenCipherService` (AES-256-GCM) в `ProviderCredential`, в
  ответе и логах открытых значений нет. `GET /integrations` отдаёт
  `bitrix24`/`moysklad` со статусом `active`/`disconnected`/`error` и
  `source` (`user`|`env`). Вебхук проверяется до сохранения: только
  `https://`, домен `*.bitrix24.ru` и путь `/rest/`; токен МойСклада — от 10
  символов.
- `moysklad_create_order` передаёт обязательные `organization` и `agent` из
  `MOYSKLAD_DEFAULT_ORGANIZATION_ID`/`MOYSKLAD_DEFAULT_AGENT_ID` (ссылки
  `meta.href` собираются от `MOYSKLAD_BASE_URL`). Если переменные не заданы
  или некорректны — 503 `errors.provider_not_configured` до вызова MCP;
  реальный заказ больше не падает с 412 от JSON API 1.2.
- Zod-схемы UI (`apps/web/src/lib/integrations.ts`) и API-ответ сверены
  тестом `ui-contract.sync.spec.ts`; переменные заказа добавлены в
  `.env.example` и прокинуты в API-контейнер `docker-compose.mcp.yml`.

**Известные проблемы:** KI-075 и KI-080 закрыты; KI-076 (поле вебхука
открытым текстом) и KI-077 (общий env-секрет MCP) остаются открытыми.

### Web: интеграции Битрикс24 и МойСклад (треки K/L)

- В разделе «Настройки → Интеграции» появились карточки «Битрикс24» и
  «МойСклад»: поле `Webhook URL` и `API Token` соответственно, кнопки
  «Подключить» / «Отключить», статус, подсказки и локализованные ошибки
  (RU/EN). Группа провайдеров переименована в «Внешние сервисы».
- Контракт UI (`apps/web/src/lib/integrations.ts`) расширен провайдерами
  `bitrix24` и `moysklad`: `POST/DELETE /api/v1/integrations/bitrix24`
  (`{ webhookUrl }`) и `POST/DELETE /api/v1/integrations/moysklad`
  (`{ apiToken }`). Если `GET /api/v1/integrations` этих ключей не отдаёт,
  Zod-схема подставляет `disconnected`, поэтому старый API продолжает
  работать.
- Валидация до запроса: вебхук обязан быть абсолютным `https://`-URL
  (`http://`, `javascript:` и относительные пути отклоняются), токен
  МойСклада — непустая строка разумной длины; пробелы по краям обрезаются,
  пустые значения не отправляются.
- API-маршрутов под новые провайдеры пока нет: до их появления подключение
  отвечает 404 «Интеграция пока недоступна» (KI-075).

**Новые известные проблемы:** KI-075, KI-076.

### Tracks K & L: Bitrix24 + MoySklad MCP

- Добавлены минимальные MCP-серверы `bitrix24-mcp` (5003) и `moysklad-mcp` (5004) в `docker-compose.mcp.yml` с healthcheck и общим `MCP_AUTH_TOKEN`. Транспорт — MCP HTTP/SSE, совместимый с `McpClient`; ключи передаются только MCP-контейнерам.
- `bitrix24-mcp`: Inbound Webhook `BITRIX24_WEBHOOK_URL`; реальные методы `crm.deal.list/get/add/update`, `crm.contact.list`, `crm.company.list`. Внешний URL — только `https` и `*.bitrix24.ru`, путь обязан содержать `/rest/`; локальные адреса разрешены для smoke-тестов.
- `moysklad-mcp`: JSON API 1.2 (`MOYSKLAD_BASE_URL`, Bearer `MOYSKLAD_TOKEN`); инструменты `product_list/get`, `stock_report`, `customer_order_list/get/create`, `counterparty_list`. Внешний base URL — только `https`/`*.moysklad.ru`.
- Egress allowlist расширен на `*.bitrix24.ru` и `*.moysklad.ru` в `DEFAULT_OUTBOUND_ALLOWLIST` и в env-примерах API/LLM worker. `GETSTARTED.md` и Runbook описывают получение вебхука и токена, запуск и проверку MCP. Остаточные ограничения — KI-077/KI-078.

### Agent: инструменты CRM и склада (треки K/L)

- Новые инструменты агента: `bitrix24_get_deal`, `bitrix24_update_deal`,
  `moysklad_check_stock`, `moysklad_get_cost`, `moysklad_create_order`.
  Вызовы идут через `MarketplaceMcpService` в MCP-серверы Битрикс24 и
  МойСклада (действия `crm_deal_get`, `crm_deal_update`, `product_get`,
  `customer_order_create`); endpoint берётся из `mcp_endpoint` навыка,
  fallback — `BITRIX24_MCP_URL`/`MOYSKLAD_MCP_URL`.
- Строгие Zod-схемы аргументов в `tool-schemas.ts` и политики в
  `tool-policies.ts`: лишние ключи, неверные типы и слишком длинные строки
  отклоняются до вызова MCP. Ответы провайдеров тоже проходят Zod:
  сделку и заказ агент получает нормализованными (`dealId`, `stageId`,
  `stageFinal`, `available`, `cost` в рублях, `orderId`).
- HITL: оба навыка помечены `requiresApproval`, но в подтверждение попадают
  только пишущие инструменты — чтение сделки, остатков и себестоимости граф не
  останавливает. Политика `tool-policies.ts` сужает необратимый случай до
  перехода в «Успешно» (`WON`), а `moysklad_create_order` подтверждается
  всегда. Runtime выполняет необратимый вызов только при свежем (10 минут)
  `approved`-решении `PendingApproval` для этого инструмента и диалога; ошибка
  чтения БД трактуется как «одобрения нет» (fail-closed). Из-за гранулярности
  HITL по имени инструмента подтверждение для `bitrix24_update_deal`
  запрашивается и на промежуточную стадию (KI-079).
- Секреты Битрикс24/МойСклада в API не нужны: вебхук и токен читает
  MCP-контейнер, гейт проверяет только endpoint (`BITRIX24_MCP_URL`/
  `MOYSKLAD_MCP_URL` или `mcp_endpoint` навыка). Без endpoint'а инструмент
  отвечает 503 `errors.marketplace_unavailable` с подсказкой, какую
  переменную задать.
- Pay-per-Call: `bitrix24-crm` и `moysklad-warehouse` стоят 15 ₽ за вызов,
  списание идёт после успешного ответа MCP, а не до него.
- Ошибки провайдера (401/429, не-JSON ответ) маппятся в 502
  `errors.mcp_provider` с сохранением HTTP-статуса в сообщении; 4xx не
  ретраятся.
- Конверт MCP-вызова: для известных действий с вложенными параметрами
  (`crm_deal_update.fields`, `customer_order_create.payload`) действует
  строгая схема действия, неизвестные действия остаются на плоской
  структурной схеме.
- Контракт «инструмент → действие MCP» зафиксирован в
  `docs/architecture/MCP-ERP-Connectors.md`.

**Новые известные проблемы:** KI-079, KI-080, KI-081.

### Billing: честный лог повторной доставки webhook

- `BillingService.addFunds` возвращает `replayed: true`, если ключ
  идемпотентности уже обработан и новая запись в Ledger не создаётся.
- `POST /billing/webhook` в этом случае пишет «уже зачислен — повторная
  доставка не начисляет» вместо «зачислено». Раньше лог утверждал, что деньги
  начислены повторно, хотя баланс и Ledger не менялись. Поведение начисления
  не изменилось, проверено на тестовом магазине ЮKassa.

### Sprint 20: Real Documents, OCR, HR & Content

#### Documents API & Tools

- `POST /api/v1/documents` (multipart, JWT, лимит 15 МБ, PDF/PNG/JPEG/WebP). Закрывает KI-065.
- Собственный парсер `extract_pdf` (поддержка PDF 1.5+, object streams, кириллица через ToUnicode).
- `write_docx` — генерация валидного OOXML (заголовки, списки, таблицы) через `adm-zip`.
- `document-analyzer` — извлечение реквизитов договоров (суммы, даты, стороны, ИНН) из PDF/DOCX/сканов.

#### OCR & Sandbox

- `sandbox/Dockerfile` расширен утилитами `tesseract-ocr`, `poppler-utils` (pdftotext) и `pandoc` для генерации DOCX.
- `ocr-smart-engine` — реальный вызов SDE-совместимого API с fallback на локальный Tesseract.
- Egress allowlist расширен для `ocr.api.cloud.yandex.net` и `api.tavily.com`.

#### Content & HR

- `check_facts` (Трек F) — реальный поиск через Tavily, сравнение источников, выявление противоречий.
- `screen_resume` (Трек G) — реальный парсинг навыков, опыта и образования, расчет скоринга под требования.
- `dzen-article` — HITL (Human-in-the-Loop) и Pay-per-Outcome закреплены тестами.

#### Web UI: загрузка документов

- Панель загрузки документов (`DocumentUploader`): drag-and-drop, прогресс, отмена, обработка лимитов и типов.
- Визуализация результатов: Markdown-таблицы рендерятся как `<table>`, JSON-резюме — как карточки кандидатов.
- Карточка HITL-одобрения «Одобрить публикацию» / «Отклонить» для `dzen-article` в чате и AI-Офисе.

**Новые известные проблемы:** KI-066–072 (пост-пилотные доработки парсеров, безопасность загрузок, контракты Yandex Vision).

### Sprint 20: Documents UI, agent results & dzen HITL

- В чате появилась загрузка документов: кнопка-скрепка открывает панель с
  drag-and-drop и выбором файла (PDF, PNG, JPEG, WebP до 15 МБ). Файл
  проверяется Zod-схемой до отправки (тип, пустой файл, лимит), загрузка
  идёт в `POST /api/v1/documents` с прогрессом из `onUploadProgress`
  (100% — только после ответа сервера), отменяется по кнопке и не теряет
  выбранный файл.
- Контракт `POST /documents` описан в `apps/web/src/lib/documents.ts`:
  `{ id, filename, mimeType, size, kind?, text?, pages?[], tables?[],
  warnings?[], createdAt? }`. Схема терпимая: плоский `text` или
  постраничный `pages[].text`, таблицы с `columns` и без них, `kind`
  выводится из MIME. Ошибки различаются по категориям: 404/405/501 —
  «эндпоинт не выкачен» (KI-065), 413 — размер, 415 — тип, без ответа —
  сеть.
- Результат разбора показывается в панели: извлечённый текст, таблицы,
  предупреждения парсера и кнопка «Отправить текст в чат» (текст плюс
  таблицы в Markdown).
- Ответы агентов рендерятся по разметке (`lib/message-blocks.ts`):
  pipe-таблицы — настоящими таблицами с горизонтальным скроллом, fence с
  языком — блоком кода с подписью, JSON `resume-screener` — карточками
  кандидата (навыки, опыт, образование, скор и вердикт). Незакрытый fence
  во время стрима остаётся текстом, разметка экранируется, произвольный
  HTML не исполняется.
- HITL для `dzen-article`: если агент остановился на `publish_to_dzen`,
  в чате появляется карточка «Одобрить публикацию» / «Отклонить»; в
  AI-Офисе так же подписаны кнопки в карточке агента и в списке ожиданий.
  Решение отправляется событием `approve_action`, ответ приходит потоком
  как обычное сообщение агента, список ожиданий инвалидируется.
- i18n RU/EN: новые разделы `chat.upload`, `chat.results`, `chat.approval`,
  `office.pending.approve*`, `office.approval.publish*`.
- Тесты: `documents.test.ts` (27), `message-blocks.test.ts` (11),
  `resume.test.ts` (6), `approval.test.ts` (2), `MessageContent.test.ts`
  (+3 кейса на таблицу, код и карточки резюме).
- Остатки: маршрута `POST /documents` в API пока нет (KI-065); формат
  результата агента остаётся договорённостью UI (KI-066), а инструмент
  HITL известен только из `GET /chat/pending` (KI-067).

### Sprint 20: реальные документы, OCR, фактчекинг и скрининг (KI-014)

- `extract_pdf` (`pdf-extractor`) разбирает PDF без внешних бинарников
  (`apps/api/src/agent/documents/pdf-text.ts`): объекты и потоки
  `/FlateDecode`, object streams PDF 1.5+ (`/Type /ObjStm`), дерево страниц,
  операторы `BT/ET/Tf/Td/TD/Tm/T*/Tj/TJ/'/"`, `ToUnicode` CMap (кириллица) и
  WinAnsi, строки/таблицы по геометрии колонок. Возвращает постраничный текст,
  таблицы, метаданные и `warnings` (шифрование, неподдержанный фильтр, лимит
  страниц).
- `write_docx` (`docx-writer`) собирает валидный OOXML-пакет (Content Types,
  `document.xml`, `styles.xml`, связи) через `adm-zip`: заголовки 1–3, абзацы,
  списки и таблицы с границами. Файл пишется в `DOCUMENTS_OUTPUT_DIR`
  (`./docx-output`, в compose — `/app/docx-output`), имя проверяется Zod.
- `ocr_document` (`ocr-smart-engine`) вызывает SDE-совместимый OCR по
  `OCR_API_URL` (`{content, mimeType, language}` → `text`), опрашивает
  асинхронную задачу (`taskId`/`status`), валидирует ответ Zod и при сбое
  переключается на Tesseract в песочнице (маркер отсутствия бинарника отдаёт
  понятную 503). Ответы разных вендоров сводятся к одному тексту.
- `check_facts` (`fact-checker`) вместо Mock ищет утверждения в Tavily
  (`POST https://api.tavily.com/search`, `TAVILY_API_KEY`, домен добавлен в
  `DEFAULT_OUTBOUND_ALLOWLIST`), сравнивает источники по значимым словам и
  числам: `supported` (2+ независимых домена), `single_source`,
  `contradicted`, `unverified`. В ответе — ссылки, цитаты, `confidence`, сводка.
- `screen_resume` (`resume-screener`) разбирает реальный текст: контакты,
  навыки (словарь + раздел «Навыки»), опыт по диапазонам дат с объединением
  пересечений, образование, языки. `score` считается только при переданных
  требованиях (70 % покрытие навыков / 30 % опыт) и объясняется `scoreFormula`;
  верхний уровень ответа совпадает с контрактом карточек UI
  (`apps/web/src/lib/resume.ts`).
- `extract_document_data` (`document-analyzer`) читает текст, PDF, DOCX, TXT/MD
  или скан (через OCR) и извлекает суммы с валютой, даты (ДД.ММ.ГГГГ,
  ГГГГ-ММ-ДД, «12 марта 2026 г.»), стороны, номер, ИНН/КПП/ОГРН и подписанта.
  Каждое значение содержит `raw` и контекст, `primaryAmount`/`primaryDate`
  выбираются по описанным правилам, отсутствие данных — `warnings`, а не
  подставленные значения.
- Новый маршрут `POST /api/v1/documents` (`apps/api/src/documents/`):
  multipart-поле `file`, JWT, лимит 15 МБ, PDF/PNG/JPEG/WebP, rate limit
  30/мин. Ответ совпадает с контрактом UI загрузки (`{id, filename, mimeType,
  size, kind, text, tables, warnings, createdAt}`), `UploadErrorFilter` отдаёт
  `413 errors.document_too_large` и `415 errors.unsupported_document_type`.
- Инструменты `extract_pdf`, `write_docx`, `ocr_document` зарегистрированы в
  реестре и политиках Gateway (всего 22 инструмента), пути к файлам
  ограничены `DOCUMENTS_INPUT_DIR` (обход каталога запрещён), размер и объём
  текста — лимитами `DOCUMENTS_*`.
- Starter skills: три новых навыка в `16-documents/` (`pdf-extractor`,
  `docx-writer`, `ocr-smart-engine`) и обновлённые `fact-checker`,
  `resume-screener`, `document-analyzer` — без «заглушек», с описанием
  реальных контрактов и ограничений; всего 22 стартовых навыка.
- HITL и Pay-per-Outcome `dzen-article` закреплены тестом
  `apps/api/src/agent/dzen-article.spec.ts`: манифест требует одобрения,
  цена 100 ₽, hold создаётся до вызова, фиксируется только после успешной
  записи черновика и отменяется при ошибке или отказе.
- Env: `OCR_*` (адрес, ключ, авторизация, таймауты, Tesseract),
  `DOCUMENTS_INPUT_DIR`/`OUTPUT_DIR`/`MAX_*`; в compose добавлены env и
  монтирование `./documents` (ro) и `./docx-output`; `api.tavily.com` добавлен
  в `API_OUTBOUND_ALLOWLIST` и default-allowlist.
- Тесты: `pdf-text.spec.ts` (10), `docx-builder.spec.ts` (7),
  `document-fields.spec.ts` (15), `ocr-smart-engine.service.spec.ts` (14),
  `document-tools.service.spec.ts` (23), `resume-parser.spec.ts` (13),
  `resume-screener.service.spec.ts` (9), `fact-checker.service.spec.ts` (13),
  `documents.service.spec.ts` (9), `documents.controller.spec.ts` (6),
  `dzen-article.spec.ts` (8), обновлены политики (48).

### Sprint 20: инфраструктура документов и OCR

- Образ `skillwharf-sandbox` (`sandbox/Dockerfile`) получил инструменты для
  документов: `tesseract-ocr` с языками `rus`/`eng` (локальный OCR-fallback),
  `poppler-utils` (`pdftotext`, `pdfinfo`, `pdftoppm`) и `pandoc-cli` для
  генерации DOCX. LibreOffice не добавлялся: +578 МБ на образ; для DOCX
  достаточно `pandoc`. `font-dejavu` добавлен для растеризации PDF без ошибок
  `Couldn't find a font`.
- Egress: `ocr.api.cloud.yandex.net` добавлен в `DEFAULT_OUTBOUND_ALLOWLIST`
  (`packages/shared/src/outbound.ts`), `API_OUTBOUND_ALLOWLIST` и
  `LLM_WORKER_OUTBOUND_ALLOWLIST` в `.env.example`/`docker-compose.yml`.
  On-prem Smart Document Engine остаётся private-хостом и проходит без
  allowlist.
- Env: в `.env.example` и `docker-compose.yml` описан контракт `OCR_*`,
  который уже читает `OcrSmartEngineService`: `OCR_API_URL`, `OCR_API_KEY`,
  `OCR_API_AUTH_HEADER`, `OCR_API_AUTH_PREFIX`, `OCR_API_TIMEOUT_MS`,
  `OCR_MAX_POLL_ATTEMPTS`, `OCR_POLL_INTERVAL_MS`, `OCR_TESSERACT_ENABLED`,
  `OCR_TESSERACT_LANG`, `OCR_MAX_IMAGE_BYTES`. Пустой `OCR_API_URL` означает
  работу только через Tesseract.
- Проверки: `scripts/fixtures/document-smoke.py` и
  `scripts/test-documents.sh` прогоняют PDF → `pdftotext` → `pdftoppm` →
  `tesseract` и Markdown → `pandoc` → DOCX под ограничениями навыка
  (read-only rootfs, uid 65534, tmpfs `/tmp`, без сети, 128 МБ, seccomp).
  В CI добавлен шаг `Test Sandbox Documents (OCR, PDF, DOCX)`.
  `scripts/test-integrations.sh --ocr` проверяет OCR-endpoint без печати
  ключа: 2xx и 400/422 — ключ принят, 401/403 — ошибка прав.
- Тесты: `packages/shared/src/outbound.test.ts` и
  `apps/api/src/integrations/provider-http.spec.ts` закрепляют allowlist для
  облачного OCR и запрет произвольного внешнего хоста.

### Sprint 19: Integration keys (Ozon/WB/Midjourney)

- Новые маршруты `POST/DELETE /api/v1/integrations/{ozon|wildberries|midjourney}`
  (KI-063 закрыт): Ozon — `{clientId, apiKey}`, Wildberries — `{apiToken}`,
  Midjourney — `{apiKey}` (TT-API-KEY). `GET /api/v1/integrations` теперь
  отдаёт `ozon` (со `clientId`), `wildberries` (с `tokenExpiresAt`, +180 дней
  от подключения) и `midjourney` со статусами `active`/`disconnected`/`error`
  и полем `source` (`user`/`env`).
- Ключи хранятся per-user в `ProviderCredential` (миграция
  `20261113203000_add_provider_credentials`). Секреты шифруются
  `TokenCipherService` (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) в envelope
  `v1:<iv>:<tag>:<ciphertext>`; в БД нет ни Client ID, ни токенов открытым
  текстом. `metadata` — только неконфиденциальный срок действия токена WB.
- Тела запросов валидируются Zod (`.strict()`), без JWT — `401`, на неверное
  тело — `400 errors.invalid_request`, без `TOKEN_ENCRYPTION_KEY` — `503
  errors.provider_not_configured`. Просроченный токен WB даёт статус `error`
  с причиной, битый envelope — `error` и запись в лог, а не падение GET.
- Инструменты читают ключи по `userId`: `MarketplaceMcpService` (Ozon/WB) и
  `MidjourneyService` (TTAPI) берут подключение пользователя, env остаётся
  fallback для системных ботов. `generate_image` и `ozon_mcp_call`/
  `wb_mcp_call` передают `userId` вниз. Без ключей — `503
  errors.marketplace_unavailable`/`errors.provider_not_configured` с
  подсказкой про раздел «Интеграции».
- Ограничение: MCP-контейнеры Ozon/WB по-прежнему аутентифицируются своими
  env-ключами, поэтому личные ключи не влияют на фактические запросы к
  Seller API — KI-064.
- Тесты: `provider-keys.service.spec.ts` (15), `integrations.controller.spec.ts`
  (11), `marketplace-mcp.service.spec.ts` (6), `midjourney.service.spec.ts`
  (+3 про ключ пользователя), `agent-tools.service.spec.ts` (+2 про `userId`).

### Sprint 19: Finance REST API (`/finance/*`)

- Добавлен `FinanceController` (`apps/api/src/finance/`), закрывающий KI-060:
  `GET /api/v1/finance/overview` — агрегат последних `unit-economics`,
  `profit-leak-detector` и `fraud-shield-audit` текущего пользователя;
  fallback-маршруты `GET /finance/unit-economics`, `/finance/profit-leaks`,
  `/finance/fraud-shield` отдают те же данные по частям и поддерживают
  фильтры `sku`, `marketplace`, `campaignId`.
- Контракт ответа — `apps/api/src/finance/finance-contracts.ts`: Zod-схемы
  повторяют `apps/web/src/lib/finance.ts`, дополнительные поля инструментов
  (`spend`, `adSpend`, `deductions`, `antifraudRecords`) сохраняются через
  `.passthrough()`. Совместимость закреплена тестом с зеркалом UI-схемы.
- Данные — реальные результаты MCP-вызовов Ozon/WB: `AgentToolsService`
  после успешного tool call'а (и списания BAL) пишет ответ в
  `FinanceSnapshotStore`. REST ничего не пересчитывает, не делает MCP-запросов
  на GET и не обходит Pay-per-Call/Pay-per-Outcome.
- Хранилище: Redis (`REDIS_URL`, TTL `FINANCE_SNAPSHOT_TTL_SECONDS`, по
  умолчанию 7 суток), резерв — память процесса. Дедупликация
  `unit-economics` по `marketplace|sku` (до 10 записей), по 3 последних
  результата для leaks/audit.
- Если расчётов не было: `200` с `dataAvailable:false` и причиной, а не
  `404`, пустой массив без признака или вымышленные суммы. `userId` — только
  из JWT, данные пользователей не смешиваются; некорректные query — `400`
  `errors.invalid_request`.
- Тесты: `finance.controller.spec.ts` (10), `finance-snapshot.store.spec.ts`
  (7), в `agent-tools.service.spec.ts` — запись снапшотов после вызова
  (включая «без userId не пишем» и «ошибка хранилища не ломает tool call»).
- Новый остаток: KI-063 — подключение ключей из UI
  (`POST/DELETE /integrations/{ozon,wildberries,midjourney}`) остаётся за
  бэкендом; финансовый дашборд от него не зависит.

### Sprint 19: Finance & Creative Integrations UI

- В разделе «Интеграции» появились карточки Ozon, Wildberries и Midjourney:
  Ozon — Client ID + API Key (цены v1, товары v3); Wildberries — только
  `API Token` с предупреждением о сроке 180 дней и показом `tokenExpiresAt`/
  `expiresAt`; Midjourney — `TT-API-KEY` с пометкой TTAPI (не официальный
  API). Статусы `active`/`disconnected`/`error`, подключение и отключение.
- Чат распознаёт изображения в ответе агента (Markdown и прямые URL,
  включая `imageUrl` TTAPI): показывает превью и открывает оригинал в новой
  вкладке; небезопасные схемы (`javascript:`, `data:`) в `<img>` не
  превращаются.
- Добавлена защищённая страница `/app/finance`: выручка, прибыль (`margin`),
  маржа (`marginPercent`), таблица unit-economics по SKU, алерты
  `profit-leak-detector` и статус `fraud-shield-audit`, выведенный из
  `findings`/`checks`. Контракт использует реальные поля
  `FinanceToolsService`: `GET /finance/overview` с fallback на
  `/finance/unit-economics`, `/finance/profit-leaks` и
  `/finance/fraud-shield`; ответы валидируются Zod,
  `errors.provider_unavailable` локализуется.
- Остатки: KI-060 (финансовый REST-контракт) закрыт в разделе «Finance REST
  API» выше; KI-063 — подключение ключей Ozon/WB/Midjourney из UI пока не
  реализовано (`KI-057`–`KI-062` заняты бэкенд-задачами).

### Sprint 19: Real Finance Data & Midjourney (backend)

- Финансовые инструменты больше не используют Mock: `calculate_unit_economics`,
  `detect_profit_leaks`, `monitor_competitor_prices` и `audit_fraud_risk`
  вызывают реальные MCP-действия Ozon/WB. Сверка с аудитом API (11.2026):
  `ozon_analytics` → `/v1/analytics/data`; `ozon_finance_totals` /
  `ozon_finance_transactions` → начисления `/v1/finance/accrual/by-day`
  (аудит указывает `/v3/finance/transaction/list`, но Ozon его отключил —
  MCP-сервер пересобирает операции по дням); `ozon_get_prices` →
  `/v5/product/info/prices` (это read-метод; `/v1/product/import/prices` —
  write-импорт цен); `ozon_pricing_competitor_prices`,
  `ozon_ad_campaigns`, `ozon_ad_statistics_expenses`.
  WB: `wb_finance_report` (отчёт о реализации), `wb_deductions`,
  `wb_prices_list` → хост `discounts-prices-api.wildberries.ru`,
  `/api/v2/list/goods/filter` (авторизация — raw `Authorization` внутри MCP),
  `wb_prices_quarantine`, `wb_advert_list`, `wb_advert_costs`,
  `wb_analytics_antifraud`.
- `detect_profit_leaks` для Ozon дополнительно анализирует реальные
  `ozon_finance_transactions` (accruals): отрицательные начисления
  группируются по категориям, топ-5 попадает в `findings` как
  `transaction_anomaly`.
- Вынесен `MarketplaceMcpService`: endpoint провайдера берётся из
  `mcp_endpoint` навыка или `OZON_MCP_URL`/`WB_MCP_URL`, клиент/gateway
  кешируются, ошибки MCP маппятся в единый JSON. `ozon_mcp_call`/
  `wb_mcp_call` используют его же.
- `FinanceDataService` валидирует и нормализует ответы MCP (Zod-обёртки,
  camelCase/snake_case, вложенные `data.list`/`report`/`accruals`); не-JSON
  и отсутствие обязательных полей — 502 `errors.mcp_provider`, пустой
  валидный ответ — `dataAvailable:false` без фейковых чисел.
- `generate_image` реально работает через TTAPI (единственный разрешённый
  провайдер): `POST https://api.ttapi.io/midjourney/v1/imagine` с заголовком
  `TT-API-KEY` и `{prompt, mode:"fast"}` → `jobId` → поллинг
  `GET https://api.ttapi.io/midjourney/v1/fetch?jobId=...` до `completed` →
  `imageUrl`. Базовый URL и пути зафиксированы в коде; GoAPI/UseAPI и
  Discord-обёртки не используются. 429/5xx повторяются с экспоненциальным
  backoff, `failed`/таймаут — `provider_unavailable`, без ключа — 503
  `provider_not_configured`. Env: `MIDJOURNEY_API_KEY`,
  `MIDJOURNEY_POLL_INTERVAL_MS`, `MIDJOURNEY_TIMEOUT_MS`.
- Оплата: Pay-per-Call для `detect_profit_leaks`/`generate_image`
  списывается через BAL после успешного реального вызова; Pay-per-Outcome
  (`fraud-shield-audit`, `dzen-article`) — hold до подтверждения и capture
  после успеха; ошибка провайдера отменяет hold. Проверено
  `agent-runtime.service.spec.ts`.
- Strict-схемы MCP-действий расширены финансовыми операциями (даты, лимиты,
  `view`, `filter_nm_id`, `metrics`/`dimensions`), `ozon_get_prices`
  поддерживает реальные `offer_id`/`product_id`.
- Обновлены манифесты навыков (без «заглушек», периоды, `cost`, ограничения
  ERID/UTM), `.env.example` и `docker-compose.yml` (TTAPI, allowlist,
  retry).
- Тесты: `finance-data.service.spec.ts` (включая `ozon_finance_transactions`),
  `finance-tools.service.spec.ts` (аномалии транзакций),
  `midjourney.service.spec.ts` (nock TTAPI: imagine/fetch, TT-API-KEY,
  mode=fast, 429/5xx/failed/timeout/no-key), `agent-tools.service.spec.ts`,
  `agent-runtime.service.spec.ts`, `mcp-gateway.spec.ts`.
- KI-015 и KI-055 закрыты; остатки — KI-061 (распределение расходов Ozon)
  и KI-062 (ERID/UTM не отдаются MCP).

### Sprint 19: Midjourney & Marketplace Integrations

- Добавлены секреты Midjourney через TTAPI (единственный выбранный прокси):
  `MIDJOURNEY_API_KEY`, `MIDJOURNEY_BASE_URL=https://api.ttapi.io`,
  `MIDJOURNEY_WEBHOOK_URL` (опционально). GoAPI/UseAPI и хосты
  `api.goapi.ai`/`api.midjourney.com` не используются. Для egress добавлены
  `api.ttapi.io`, `api-performance.ozon.ru` (Ozon Performance) и
  `discounts-prices-api.wildberries.ru` (WB Pricing) в
  `API_OUTBOUND_ALLOWLIST`/`LLM_WORKER_OUTBOUND_ALLOWLIST` и default
  allowlist `@skillwharf/shared`.
- Ozon/WB MCP: ключи по-прежнему передаются только контейнерам MCP через
  env; добавлен `infra/mcp/healthcheck.py`, который в healthcheck проверяет
  наличие `OZON_CLIENT_ID`/`OZON_API_KEY` или `WB_API_TOKEN` и доступность
  `/api/health`. Пустые ключи делают контейнер unhealthy (обход только
  `MCP_ALLOW_MISSING_KEYS=1` для локальной панели).
- `scripts/test-integrations.sh`: Ozon — `POST /v1/product/import/prices`
  с пустым `prices:[]` (без изменения цен), WB — `GET /ping` на
  `discounts-prices-api.wildberries.ru`, Midjourney — TTAPI
  `GET /midjourney/v1/fetch?jobId=test` (404/2xx — ключ принят, 401 —
  ошибка); без ключей — WARN/SKIP. Секреты не печатаются.
- Runbook: получение ключей TTAPI, Ozon Performance, WB Pricing; отдельные
  хосты финансовых API, проверка 180-дневного токена WB, запуск
  MCP-стека, healthcheck и проверка коннектов.
- Новые ограничения: KI-057 (healthcheck не проверяет scope/срок ключей),
  KI-058 (тестовые endpoint'ы версионно-зависимы), KI-059 (нет официального
  Midjourney API/SLA).

### Sprint 18: Telegram Webhooks, Google OAuth & Egress

- Caddy (`deploy/Caddyfile`, `deploy/Caddyfile.staging`) проксирует
  `POST /api/v1/webhooks/telegram` напрямую в `api:3000`, минуя web-контейнер;
  публичный alias в API — `TelegramPublicWebhookController`. Секрет
  `X-Telegram-Bot-Api-Secret-Token` проверяется constant-time; без
  `TELEGRAM_WEBHOOK_SECRET` endpoint отвечает fail closed.
- Rate limit webhook: `TELEGRAM_WEBHOOK_RATE_LIMIT` (по умолчанию 120
  запросов/мин на IP) через `@nestjs/throttler`; `trust proxy` уже включает
  реальный IP из Caddy `X-Forwarded-For`.
- Google Workspace OAuth: env `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_REDIRECT_URI`, `GOOGLE_OAUTH_SCOPES`; refresh/access-токены
  сохраняются только в зашифрованном виде (AES-256-GCM,
  `TOKEN_ENCRYPTION_KEY`), KMS-абстракция `KeyManagementService` оставляет
  возможность заменить локальный ключ на облачный KMS.
- Prisma: модели `GoogleCredential`, `TelegramBot`, `TelegramChatLink` и
  миграция `20261113190000_add_integrations`; токены в БД — envelope
  `v1:<iv>:<tag>:<ciphertext>`, открытых значений нет.
- Egress: общий allowlist в `@skillwharf/shared`; API проверяет его в
  `provider-http` перед Telegram/Google-запросами, worker — перед вызовом
  LLM. Разрешены `api.telegram.org`, `www.googleapis.com`,
  `oauth2.googleapis.com`, `sheets.googleapis.com`,
  `docs.googleapis.com` и домены LLM-провайдеров; локальные dev-адреса
  проходят отдельно. Env: `API_OUTBOUND_ALLOWLIST`,
  `LLM_WORKER_OUTBOUND_ALLOWLIST`.
- Тесты: шифрование/подмена ciphertext, проверка секрета webhook,
  rate-limit env, egress-allowlist API/worker, shared-парсер.

#### Инструменты и реальные интеграции (KI-012)

- `send_message` вызывает Telegram Bot API с inline-клавиатурой (до 8
  кнопок `url`/`callbackData`); исходящие идут от бота пользователя
  (`TelegramBot`, AES-256-GCM), иначе от системного `TELEGRAM_BOT_TOKEN`.
  Каналы `vk`/`whatsapp` пока не подключены — 400 `errors.invalid_request`.
- `google_sheets_append` реально добавляет строки (Sheets API v4
  `values:append`, `USER_ENTERED`), `google_docs_create` создаёт документ и
  вставляет текст (Docs API `batchUpdate`), добавлен
  `google_calendar_create` (Calendar API v3, ISO 8601, attendees). Все
  Google-инструменты работают от имени пользователя: `userId` прокидывается
  из `AgentRuntimeService` в `AgentToolsService`, токен обновляется по
  `refresh_token`, при 401 — один принудительный refresh и повтор.
- OAuth: `GET /integrations/google/authorize|authorization-url` с
  HMAC-подписанным `state`, `GET /integrations/google/callback`
  (обмен кода, email из `id_token`, redirect в UI при
  `GOOGLE_OAUTH_SUCCESS_REDIRECT`), `GET /integrations/google/status`,
  `DELETE /integrations/google`; подключение бота —
  `POST/DELETE /integrations/telegram`, сводный статус —
  `GET /integrations`.
- Ошибки провайдеров: 429 после экспоненциального backoff (с учётом
  `Retry-After`/`parameters.retry_after`) → `errors.provider_rate_limited`,
  5xx/сеть → `errors.provider_unavailable`, 401/403 →
  `errors.provider_auth_required`, нет ключей →
  `errors.provider_not_configured`, запрещённый egress →
  `errors.outbound_blocked`. Env: `PROVIDER_RETRY_*`.
- Инструменты и политики: новые описания без «заглушек», кнопки
  `send_message` в strict-схеме policy engine, `google_calendar_create` в
  `TOOL_REGISTRY`; descriptors включают calendar только если навык объявил
  его в `dependencies.tools`.
- Тесты на nock: Telegram (sendMessage, inline keyboard, 429-retry,
  exhausted 429, 401, 400, getMe, split длинного текста), Google
  Sheets/Docs/Calendar (тела запросов, 429, 401+refresh),
  OAuth (state, обмен кода, refresh, шифрование, email из id_token),
  webhook (секрет, маршрутизация в ChatService, непривязанный чат,
  callback), контракт `GET /integrations` и инструменты `AgentToolsService`.
- KI-012 закрыт для `messenger-connector`/`google-workspace`; остаток
  внешних API — KI-055. KI-050 закрыт (redirect + контракт UI); KI-014
  (content/HR/legal) вне Sprint 18.

### Sprint 18: Integration Management UI

- На странице настроек появился раздел «Интеграции»: Telegram (`Bot Token`,
  проверка через `getMe`, имя бота, отключение) и Google Workspace (переход на
  OAuth URL, статус, email аккаунта, отзыв доступа).
- Состояние интеграций запрашивается через `GET /api/v1/integrations` и
  валидируется Zod (`apps/web/src/lib/integrations.ts`); поддерживаются
  статусы `active`, `disconnected`, `error` и локализованные сообщения об
  ошибках (неверный токен, недоступный OAuth, сеть, 401/403/404/5xx).
- В карточках агентов AI-Офиса и в боковой панели показываются иконки
  активных каналов Telegram/Google.
- Добавлены строки RU/EN, обновлён `apps/web/README.md`.
- Контракт UI закрыт бэкендом: `GET /api/v1/integrations`,
  `POST/DELETE /api/v1/integrations/telegram`,
  `GET /api/v1/integrations/google/authorization-url` и
  `DELETE /api/v1/integrations/google`; Google callback возвращает браузер в
  настройки при заданном `GOOGLE_OAUTH_SUCCESS_REDIRECT` (KI-050).
- Исправление контрактов после аудита Sprint 18: UI использует точный путь
  `GET /api/v1/integrations/google/authorization-url`; ответ Telegram `401`
  (и `errors.provider_auth_required`, в том числе при 502) маппится в
  `invalidToken` с сообщением «Telegram отклонил токен. Проверьте его
  правильность»; `400` сохранён как fallback.
- UI проверен unit-тестами и Playwright с mock API; реальные Telegram/Google
  требуют ключей окружения.

### Sprint 17: LLM Worker, Redis & Control Plane UI

#### LLM Worker & Architecture

- Создан отдельный NestJS-микросервис `apps/llm-worker`. В него перенесены `@langchain/*`, LangGraph, адаптеры LLM и токен-эстиматор.
- API полностью избавлен от `@langchain/*`. Размер образа API снижен до 380 МБ (цель ≤ 400 МБ). Закрывает KI-006.
- Связь API ↔ worker реализована через внутренний HTTP/NDJSON (`/v1/graphs/run`, `/v1/graphs/resume`).
- Восстановлен RAG-контекст при вызове LLM (потерян при рефакторинге).

#### Фоновые задачи и Redis

- Добавлен Redis (`redis:7-alpine`) в `docker-compose.yml`.
- Фоновые задачи (`expired-approvals`, `checkpoint-retention`) переведены на BullMQ (`upsertJobScheduler`). Исправлен баг с дублированием джобов и `jobId`.
- Добавлены внутренние эндпоинты API (`/internal/agent/*`) с защитой по `INTERNAL_API_TOKEN`.

#### LLM Router & Control Plane

- Исправлен 502 `errors.llm_unavailable` для одиночных маршрутов и env-fallback. Закрывает KI-041, KI-044.
- В Control Plane UI (вкладка «LLM Роутер») добавлены поля `taskType` и `dailyCostLimit`, добавлена валидация Zod и PATCH-эндпоинт.
- Добавлен маппинг `errors.marketplace_unavailable` (бэкенд и UI). Завершает KI-025.

**Новые известные проблемы:** KI-045–049 (mTLS, Zod-деградация, логирование уведомлений, синхронный worker→API, неполные E2E).

### Sprint 17: Control Plane LLM Router UI & Error Mapping (KI-041)

- Control Plane: в форме создания и редактирования LLM-маршрута появились
  `taskType` (`chat`/`analysis`/`embeddings`) и `dailyCostLimit`
  (₽/сутки, необязательно); таблица маршрутов показывает лимит и тип задачи,
  у строки есть кнопка «Изменить» (`PATCH /admin/llm-routes/:id`).
- `LlmRoute` описан Zod-схемой; ответы `GET`/`POST`/`PATCH /admin/llm-routes`
  валидируются до попадания в UI. Новые поля опциональны — старый API без них
  продолжает работать (`taskType` по умолчанию `chat`, лимит не задан).
- Добавлен маппинг `errors.marketplace_unavailable` в `chat-errors.ts` и
  i18n RU/EN; текстовые маркеры старого MCP/marketplace API сохранены как
  fallback.
- Сообщение для 502/503 `errors.llm_unavailable` уточнено: «Все
  LLM-провайдеры недоступны или исчерпали дневной бюджет».
- KI-041 закрыт для Control Plane UI. 502 для одиночного маршрута/env-fallback
  закрыт в `llm-worker` вместе с KI-044 (см. раздел приёмки ниже).

### Sprint 17: LLM Worker, Redis & BullMQ (KI-006)

#### LLM Worker

- Новый сервис `apps/llm-worker` (NestJS, порт 4100): LangGraph,
  `@langchain/*`, адаптеры YandexGPT/GigaChat, токен-эстиматор и граф агента
  перенесены из API. API больше не зависит от `@langchain/*`.
- Транспорт API → worker: внутренний HTTP + NDJSON-стрим
  (`POST /v1/graphs/run`, `POST /v1/graphs/resume`); события `delta`,
  `office`, `approval`, `done`, `error` валидируются Zod с обеих сторон.
- Worker → API: инструменты выполняются в Gateway через
  `POST /api/v1/internal/agent/tools/execute` (policy engine, Pay-per-Outcome,
  Ledger, песочница остаются в API); HITL-подготовка —
  `POST /internal/agent/approvals/prepare|resolve`.
- Checkpoint'ы LangGraph сериализуются в worker'е, API хранит непрозрачные
  байты (`/internal/agent/checkpoints/*`), поэтому прежний
  `PrismaCheckpointSaver` удалён без потери durability.
- Дневной бюджет: worker резервирует/сверяет токены через
  `/internal/agent/llm/budget/*`; списание в Ledger и OTel-метрики выполняет API.
- Инструменты описаны JSON Schema (`z.toJSONSchema`) в API и конвертируются в
  Zod в worker'е; схемы не дублируются вручную.

#### Redis & BullMQ

- `redis:7-alpine` в `docker-compose.yml` (AOF, healthcheck, без публикации
  порта); `api`, `llm-worker` и `redis` стартуют по healthcheck'ам.
- BullMQ в API: очередь `agent-maintenance` с повторяющимися job'ами
  `hitl-expiry` и `checkpoint-retention`, очередь `agent-notifications` для
  уведомлений об ожидающем подтверждении (канал — структурный лог, KI-047).
- Без `REDIS_URL` API сохраняет прежние `setInterval`-таймеры (dev/тесты).

#### Сборка и CI

- `pnpm build:llm-worker`, сборка Docker-образа worker'а в CI, проверка
  размера образа API (лимит 400 МБ).
- `.env.example`: `LLM_WORKER_URL`, `INTERNAL_API_TOKEN`, `REDIS_URL`.

#### Приёмка Sprint 17: KI-041/KI-044 и ошибки marketplace

- 502 `errors.llm_unavailable` теперь отдаётся и для одиночного
  маршрута/env-fallback: `LlmInferenceService` (worker) считает retriable
  последнюю попытку любой длины цепочки, ошибки 400/401/403 не маскируются,
  резерв бюджета возвращается ровно один раз (KI-044).
- `errors.marketplace_unavailable` добавлен в `apps/api/src/i18n/error-keys.ts`
  и `apps/api/src/common/api-error.ts`; marketplace-инструмент без ключей
  провайдера отвечает 503 с этим кодом вместо текстовой строки (завершение
  KI-025, UI-маппинг был добавлен ранее).
- Долговременная память снова попадает в системный промпт: `ChatService`
  подбирает `MemoryService.buildContext()` по тексту вопроса и передаёт блок в
  worker (`memoryContext` + `systemPrompt`); resume использует контекст из
  checkpoint'а.
- Тесты нового контура: `apps/api/src/chat/chat.service.spec.ts`
  (стриминг дельт, HITL-пауза, отмена устаревшего ожидания, память, paywall,
  resume), `apps/llm-worker/src/llm/inference.service.spec.ts`
  (одиночный маршрут, env-fallback, 400, fallback-цепочка, эхо-режим, settle),
  проверка `marketplace_unavailable` в `agent-tools.service.spec.ts`.

### Sprint 16: Observability, LLM Router v2 & Reliability

#### Observability & Cost Attribution

- OTel Collector добавлен в `docker-compose.yml` (профиль `monitoring`). API отправляет спаны по OTLP, коллектор пишет в stdout.
- Sentry для NestJS: включён при наличии `SENTRY_DSN`, фильтрует PII (headers, bodies, токены).
- Метрика `llm_cost_total` (рубли) с лейблами `tenant_id`, `model`, `agent_id`. В Grafana добавлены панели «Cost by Tenant» и «Tokens by Model».

#### LLM Router v2

- В `LlmRoute` добавлены `taskType` и `dailyCostLimit` (дневной лимит в ₽). Расход считается по append-only Ledger.
- Fallback-цепочки: при 429, 5xx или таймауте LLM Router переключается на следующий маршрут по `priority`. Для 400/401/403 fallback не применяется.
- 502 `errors.llm_unavailable` при исчерпании цепочки маршрутов.
- В Ledger добавлено поле `llmRouteName` для точного учёта расходов по маршрутам.

#### HITL TTL & Checkpoint Retention

- В `PendingApproval` добавлено `expiresAt` (`HITL_APPROVAL_TTL_HOURS`). Фоновый job отменяет escrow-hold, удаляет checkpoint и логирует `hitl.approval_expired`.
- Фоновый job `checkpoint-retention` удаляет старые `GraphCheckpoint` (неактивные диалоги без ожиданий, `CHECKPOINT_RETENTION_DAYS`).
- `GET /api/v1/chat/pending` отдаёт `expiresAt` для UI.

#### MCP & Egress Hardening

- MCP Gateway: динамическое обнаружение действий через `tools/list` (с кешированием на сессию), валидация `action` до вызова.
- Egress: DNS-запросы разрешены только от root (защита от tunneling через non-root код). Настроен `ip6tables` (строгий DROP по умолчанию). Исправлен баг с Docker DNAT и инжектом `/etc/hosts` при `read-only rootfs`.

#### Web UI (Sprint 16)

- Бесконечная пагинация истории Ledger (`useInfiniteQuery`, кнопка «Загрузить ещё»).
- Маппинг кодов `errors.invalid_request` и `errors.policy_blocked` в i18n (RU/EN).
- В AI-Офисе добавлен таймер TTL ожиданий (`expiresAt`), с обратной совместимостью для старых API.

**Новые известные проблемы:** KI-038–040 (OTel/Sentry hardening), KI-041 (Router UI), KI-042 (Egress SNI), KI-043 (Retention resolved).

### LLM Router v2 (Sprint 16)

- `LlmRoute` получил `taskType` (default `chat`) и `dailyCostLimit` (₽/сутки; NULL — без лимита), миграция `add_llm_router_v2`; CRUD/DTO и аудит поддерживают новые поля. Fallback-цепочки строятся в рамках одного `taskType` по `priority asc`.
- Budget guardrails на маршрут: расход за текущие UTC-сутки считается по append-only Ledger (`LedgerEntry.llmRouteName`, заполняется при LLM-списании); при `spend >= dailyCostLimit` маршрут исключается из выбора (`gen_ai.router.budget_exceeded`), остальные маршруты продолжают работать. Если все маршруты исчерпали бюджет — 503 `errors.llm_unavailable`; пустая таблица маршрутов по-прежнему означает env-fallback.
- Fallback при сбоях провайдера: HTTP 429/5xx, таймаут/AbortError/ETIMEDOUT/ECONNRESET переводят вызов на следующий маршрут цепочки с событием `gen_ai.router.fallback {from,to,reason,taskType}`; резерв токенов берётся один раз, reconcile/refund — один раз; стриминг переключается только до первой дельты; исчерпание всей цепочки — refund + 502 `errors.llm_unavailable`. Ошибки 400/401/403 не ретраятся.
- `gen_ai.usage` дополнен `gen_ai.route` (вместе с `gen_ai.usage.cost`); web распознаёт `errors.llm_unavailable` и показывает локализованное сообщение.

### HITL TTL & Checkpoint Retention (Sprint 16)

- `PendingApproval.expiresAt` + TTL `HITL_APPROVAL_TTL_HOURS` (default 24 ч); просроченные ожидания не считаются активными (approve после дедлайна отклоняется), `GET /api/v1/chat/pending` отдаёт `expiresAt` для таймера в UI.
- Фоновый `ExpiredApprovalsService` (интервал `HITL_EXPIRY_CHECK_INTERVAL_MS`, default 5 мин, первый тик сразу): отменяет escrow-hold'ы просроченных ожиданий, удаляет checkpoint треда, переводит запись в `expired`, логирует `hitl.approval_expired`; граф не возобновляется, ошибки изолированы по записям.
- Фоновый `CheckpointRetentionService` (`CHECKPOINT_RETENTION_DAYS`, default 30; интервал default 6 ч): удаляет `GraphCheckpoint`/`GraphCheckpointWrite` для диалогов, неактивных дольше cutoff и без активного ожидания, а также orphan-треды без `Conversation`; логирует `checkpoint.retention_cleaned`. Активные диалоги и ожидания не затрагиваются.
- Новые переменные `.env.example`: `HITL_APPROVAL_TTL_HOURS`, `HITL_EXPIRY_CHECK_INTERVAL_MS`, `CHECKPOINT_RETENTION_DAYS`, `CHECKPOINT_RETENTION_CHECK_INTERVAL_MS`.

### MCP Dynamic Discovery (Sprint 16)

- `McpClient.listTools()` (`tools/list`) с Zod-валидацией ответа; `McpGateway` лениво (один раз на SSE-клиент) получает набор действий и отклоняет неизвестный `action` 400 `errors.invalid_request` до `callTool`. Strict-схемы известных ozon/wb-действий и структурная валидация сохранены.
- Если `tools/list` недоступен, вызов не падает: structural-only + однократный лог `mcp.tools_list_unavailable` (провайдер, маскированное сообщение); пустой список означает отказ всех действий.
- `LlmService` кеширует gateway на инстанс `McpClient`, чтобы discovery не повторялся на каждый tool-call.

### Egress Hardening (Sprint 16)

- DNS-tunneling закрыт: DNS (udp/tcp 53) разрешён только root-entrypoint (`-m owner --uid-owner 0`), для кода под uid 65534 стоит explicit DROP по исходному dport через `conntrack --ctorigdstport` (до loopback ACCEPT). Docker DNAT `127.0.0.11:53` учтён — `--dport 53` не работает.
- `ip6tables` настраивается строго: при наличии IPv6-стека обязательны DROP-политики и loopback/ESTABLISHED/DNS-root правила; ошибка ip6tables → sandbox не запускается (fail closed); без IPv6 — skip с логом.
- Read-only rootfs: worker резолвит allowlist через `node:dns` и передаёт `HostConfig.ExtraHosts`, поэтому разрешённые домены резолвятся кодом и при `read_only: true` (проверено Docker: `getent hosts`/`curl` 200, `nslookup` fail). `/etc/hosts` из entrypoint остаётся dev-fallback.
- Зафиксированы остаточные риски: SNI/Host-фильтрация (нужен TLS egress-прокси), DNS rebinding/SSRF, IPv4-only ExtraHosts (KI-042).

### Observability & Cost Attribution (Sprint 16)

- OTel Collector в профиле `monitoring` (`otel/opentelemetry-collector-contrib:0.164.0`, конфиг `infra/otel/otel-collector.yml`): API отправляет OTLP-спаны на `otel-collector:4318`, коллектор выводит их в stdout (debug exporter), без внешних SaaS. OTLP-порты опубликованы только на `127.0.0.1`.
- OTel SDK в API: `@opentelemetry/sdk-node`, OTLP HTTP exporter, HTTP/Express/Nest-инструментации. Трассировка включается только при `OTEL_EXPORTER_OTLP_ENDPOINT`; без endpoint SDK не стартует.
- Спаны `gen_ai.*` с `gen_ai.system`, `gen_ai.agent.id`, `gen_ai.tenant.id`, `gen_ai.skill.id`, `gen_ai.request.model`, `gen_ai.usage.cost` (рубли), input/output/total tokens и `gen_ai.usage_estimated`.
- Sentry (`@sentry/nestjs`): `SentryGlobalFilter` для необработанных исключений/5xx, инициализация только при `SENTRY_DSN`. PII-фильтр отключает сбор headers/bodies/cookies/query/user/genAI inputs и MCP content, маскирует токены в сообщениях и breadcrumbs; `enableOpenTelemetrySetup: false`, чтобы не конфликтовать с OTel SDK.
- Метрика `llm_cost_total{tenant_id,model,agent_id}` в рублях; `MetricsService.countLlmCost` вызывается после каждого LLM usage (фактического или fallback). В дашборд `SkillWharf Overview` добавлены панели «Cost by Tenant» и «Tokens by Model».
- Runbook: включение/отключение OTel Collector, просмотр трейсов, настройка Sentry и PII-политика, PromQL для стоимости по tenant. Остаточные ограничения — KI-038..KI-040.

### Sprint 15: Pilot Reliability

#### HITL & Checkpointer

- Prisma-модели `GraphCheckpoint`, `GraphCheckpointWrite`, `PendingApproval`. Интеграция `PrismaCheckpointSaver` с LangGraph.
- HITL переведён на `interrupt()`/`Command({ resume })`: пауза хранится в БД, `approve_action` возобновляет граф после рестарта API.
- Escrow-hold создаётся до паузы с идемпотентным ключом; при resume hold переиспользуется.
- `GET /api/v1/chat/pending` для списка ожидающих одобрения; новое сообщение закрывает старое ожидание.

#### LLM Budget Guard

- Reserve-before-call: атомарное резервирование `prompt + max_tokens` до вызова (для всех путей).
- Reconcile после ответа (возврат/добавка), откат резерва при ошибке провайдера.
- Fallback-токенизатор (js-tiktoken) для GigaChat, если провайдер не прислал `usage`.
- Оценка токенов вынесена в `token-estimator.ts`.

#### Infrastructure & Backups

- Offsite-бэкапы в S3 через `rclone` (`upload-backup.sh`), retention.
- `restore-drill.sh` для проверки восстановления.
- One-shot `db-migrate` (init-container) вынесен из `entrypoint.sh` API. API ждёт его завершения (`service_completed_successfully`).
- `/api/v1/health/ready` и `/health/live` для k8s и Compose.

#### Billing & Marketplace

- Пагинация `GET /api/v1/billing/ledger` (keyset по `createdAt`, `id`), `nextCursor`.
- Месячный сброс Freemium-лимитов (`freemium-reset.service.ts`).

#### Web UI (Sprint 15)

- Проброс `VITE_RAG_MEMORY_ENABLED` через `docker-compose.yml` и staging.
- Маппинг MCP-ошибок (`errors.mcp_provider`, `mcp_timeout`, `mcp_unavailable`) на RU/EN с fallback.
- История операций в модалке стала пагинируемой: `useInfiniteQuery` по keyset-курсору `nextCursor`, кнопка «Загрузить ещё», состояние подгрузки и отдельная ошибка следующей страницы; уже загруженные записи не теряются. Zod-контракт вынесен в `apps/web/src/lib/ledger.ts`, дубликаты по `id` отбрасываются.
- Ошибки `errors.invalid_request` и `errors.policy_blocked` показываются переведёнными сообщениями RU/EN (`chat.errors.invalidRequest`/`chat.errors.policyBlocked`); `code` имеет приоритет над текстом, текстовый fallback сохранён. KI-025 закрыт.
- AI-Офис показывает панель «Ожидают решения» по `GET /api/v1/chat/pending`: причина (одобрение/оплата), инструменты и таймер TTL «Осталось 23 ч» по необязательному `expiresAt`. Ответ валидируется Zod (`apps/web/src/lib/pending-approvals.ts`); если `expiresAt` нет (старый API), таймер не рендерится.

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
