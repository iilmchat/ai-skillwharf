# Changelog

Все значимые изменения в проекте документируются в этом файле.

## [Unreleased]

### Sprint 20: Real Documents, OCR, HR & Content

**Documents API & Tools**
- `POST /api/v1/documents` (multipart, JWT, лимит 15 МБ, PDF/PNG/JPEG/WebP). Закрывает KI-065.
- Собственный парсер `extract_pdf` (поддержка PDF 1.5+, object streams, кириллица через ToUnicode). 
- `write_docx` — генерация валидного OOXML (заголовки, списки, таблицы) через `adm-zip`.
- `document-analyzer` — извлечение реквизитов договоров (суммы, даты, стороны, ИНН) из PDF/DOCX/сканов.

**OCR & Sandbox**
- `sandbox/Dockerfile` расширен утилитами `tesseract-ocr`, `poppler-utils` (pdftotext) и `pandoc` для генерации DOCX.
- `ocr-smart-engine` — реальный вызов SDE-совместимого API с fallback на локальный Tesseract.
- Egress allowlist расширен для `ocr.api.cloud.yandex.net` и `api.tavily.com`.

**Content & HR**
- `check_facts` (Трек F) — реальный поиск через Tavily, сравнение источников, выявление противоречий.
- `screen_resume` (Трек G) — реальный парсинг навыков, опыта и образования, расчет скоринга под требования.
- `dzen-article` — HITL (Human-in-the-Loop) и Pay-per-Outcome закреплены тестами.

**Web UI**
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
