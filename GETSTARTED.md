# 🚀 Быстрый старт SkillWharf (Руководство администратора)

Это руководство поможет вам развернуть платформу SkillWharf с нуля и настроить все необходимые интеграции для работы 10 бизнес-треков.

## 1. Системные требования

- **ОС:** Linux (Ubuntu 22.04+ / Debian 12+) или macOS/Windows с WSL2.
- **Docker:** 24+ и Docker Compose v2.
- **RAM:** Минимум 8 GB (рекомендуется 16 GB).
- **Диск:** 50 GB SSD.
- **Порты:** `8080` (веб-UI), `3001` (API), `5435` (PostgreSQL), `3003` (Grafana), `9090` (Prometheus). Порты Redis и LLM-Worker наружу не публикуются.

## 2. Установка

```bash
git clone https://github.com/iilmchat/ai-skillwharf.git
cd ai-skillwharf
cp .env.example .env
```

Сгенерируйте секреты и заполните базовые параметры в `.env`:

```bash
openssl rand -hex 32     # JWT_SECRET и INTERNAL_API_TOKEN
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
```

- `POSTGRES_PASSWORD`: придумайте надежный пароль.
- `JWT_SECRET`: случайная строка (минимум 32 символа).
- `TOKEN_ENCRYPTION_KEY`: 32 байта в base64 (или 64 hex-символа) для шифрования токенов интеграций.
- `INTERNAL_API_TOKEN`: секрет для связи API и LLM-Worker.

Запустите инфраструктуру:

```bash
docker compose up -d --build
```

*Миграции базы данных применятся автоматически через one-shot контейнер `db-migrate` (Prisma `migrate deploy`). API стартует только после его успешного завершения (`service_completed_successfully`).*

Первая сборка занимает несколько минут: собираются образы API, LLM-Worker, веб-UI и sandbox.

## 3. Переменные окружения

Эталон полного списка — `.env.example` в корне репозитория. Ниже — те же переменные по группам; в колонке «По умолчанию» указано значение из `.env.example`. Пустое значение означает, что интеграция выключена до заполнения.

### 3.1. База данных и API

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `POSTGRES_USER` | `skillwharf_admin` | Пользователь PostgreSQL. |
| `POSTGRES_PASSWORD` | `change_me_in_production` | Пароль PostgreSQL; замените перед запуском. |
| `POSTGRES_DB` | `skillwharf_db` | Имя базы данных. |
| `JWT_SECRET` | `super_secret_jwt_key_change_me` | Подпись JWT; минимум 32 символа. |
| `PORT` | `3000` | Порт API внутри контейнера; наружу опубликован `3001`. |
| `DATABASE_URL` | `postgresql://...@localhost:5435/skillwharf_db?schema=public` | Подключение к БД для запуска Prisma с хоста. В compose переопределяется на `postgres:5432`. |

### 3.2. LLM и эмбеддинги

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `LLM_BASE_URL` | `http://host.docker.internal:8034/v1` | OpenAI-совместимый endpoint (LM Studio, Ollama, vLLM). |
| `LLM_API_KEY` | `your_lm_studio_api_key` | Ключ LLM-провайдера. |
| `LLM_MODEL` | `qwen2.5-coder-7b-instruct` | Модель по умолчанию. |
| `LLM_RESERVE_OUTPUT_TOKENS` | `4096` | Резерв output-токенов на вызов: дневной лимит резервируется до запроса и сверяется после ответа. |
| `YANDEX_OAUTH_TOKEN` | пусто | OAuth-токен Yandex AI Studio; адаптер сам обменивает его на IAM и кэширует на 11 часов. |
| `YANDEX_FOLDER_ID` | пусто | Каталог Yandex Cloud для `gpt://<folder>/<model>`. |
| `YANDEX_IAM_TOKEN` | пусто | Статический IAM-токен (живет 12 часов); альтернатива OAuth-варианту. |
| `GIGACHAT_CLIENT_ID` | пусто | Client ID приложения GigaChat. |
| `GIGACHAT_CLIENT_SECRET` | пусто | Client Secret GigaChat; OAuth-токен адаптер получает сам. |
| `EMBEDDINGS_BASE_URL` | пусто | Endpoint `/embeddings`; пусто — берется `LLM_BASE_URL`. |
| `EMBEDDINGS_API_KEY` | пусто | Ключ эмбеддингов; пусто — берется `LLM_API_KEY`. |
| `EMBEDDINGS_MODEL` | пусто | Модель эмбеддингов; пусто — долговременная память отключена. |

### 3.3. LLM-Worker и фоновые задачи

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `LLM_WORKER_URL` | `http://llm-worker:4100` | Адрес LLM-Worker во внутренней сети compose. |
| `INTERNAL_API_TOKEN` | `change_me_internal_token` | Общий секрет API ↔ LLM-Worker; задайте случайное значение. |
| `REDIS_URL` | `redis://redis:6379` | Redis для BullMQ: HITL TTL, retention checkpoint'ов, уведомления. Пусто — API использует `setInterval`. |
| `FINANCE_SNAPSHOT_TTL_SECONDS` | `604800` | TTL снапшотов финансового дашборда (7 суток). Без Redis они живут в памяти процесса API. |

### 3.4. Биллинг и лимиты

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `YOOKASSA_SHOP_ID` | пусто | `shopId` магазина ЮKassa; пусто — mock-провайдер. |
| `YOOKASSA_SECRET_KEY` | пусто | Секретный ключ ЮKassa; пусто — mock-провайдер. |
| `YOOKASSA_RETURN_URL` | `http://localhost:8080/app/chat?payment=success` | Куда вернуть пользователя после оплаты. |
| `FREEMIUM_RESET_INTERVAL_MS` | `86400000` | Периодичность проверки месячного сброса Freemium-лимитов. |

### 3.5. HITL и retention checkpoint'ов

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `HITL_APPROVAL_TTL_HOURS` | `24` | Сколько часов ждет подтверждения HITL; после этого escrow-hold отменяется. |
| `HITL_EXPIRY_CHECK_INTERVAL_MS` | `300000` | Период проверки просроченных ожиданий. |
| `CHECKPOINT_RETENTION_DAYS` | `30` | Сколько дней хранить checkpoint'ы завершенных тредов. |
| `CHECKPOINT_RETENTION_CHECK_INTERVAL_MS` | `21600000` | Период проверки retention. |

### 3.6. Telegram и Google Workspace

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | пусто | Токен бота из `@BotFather`. |
| `TELEGRAM_WEBHOOK_SECRET` | пусто | Секрет webhook; проверяется в `X-Telegram-Bot-Api-Secret-Token`. |
| `TELEGRAM_WEBHOOK_RATE_LIMIT` | `120` | Лимит запросов webhook на IP в минуту. |
| `GOOGLE_CLIENT_ID` | пусто | OAuth Client ID (Web application). |
| `GOOGLE_CLIENT_SECRET` | пусто | OAuth Client Secret. |
| `GOOGLE_REDIRECT_URI` | `https://skillwharf.example.com/api/v1/integrations/google/callback` | Redirect URI; должен совпадать с настройкой OAuth client. |
| `GOOGLE_OAUTH_STATE_SECRET` | пусто | Отдельный HMAC-секрет OAuth-state; пусто — используется `TOKEN_ENCRYPTION_KEY`. |
| `GOOGLE_OAUTH_SCOPES` | пусто | Scopes через запятую; пусто — Sheets/Docs/Calendar по умолчанию. |
| `GOOGLE_CALENDAR_ID` | `primary` | Календарь по умолчанию для `google_calendar_create`. |
| `GOOGLE_OAUTH_SUCCESS_REDIRECT` | пусто | Возврат браузера после OAuth; пусто — JSON-ответ callback. |
| `TOKEN_ENCRYPTION_KEY` | пусто | Ключ шифрования refresh/access-токенов: base64 от 32 байт или 64 hex-символа. |
| `TOKEN_ENCRYPTION_KEY_ID` | `local-v1` | Идентификатор ключа для аудита и будущей ротации. |

### 3.7. Egress и повторы внешних провайдеров

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `API_OUTBOUND_ALLOWLIST` | список доменов | Разрешенные внешние домены для API (только https). |
| `LLM_WORKER_OUTBOUND_ALLOWLIST` | список доменов | То же для LLM-Worker; включает Yandex AI Studio и GigaChat. |
| `PROVIDER_RETRY_MAX_ATTEMPTS` | `3` | Число попыток при 429/5xx. |
| `PROVIDER_RETRY_BASE_DELAY_MS` | `500` | Базовая задержка экспоненциального backoff. |
| `PROVIDER_RETRY_MAX_DELAY_MS` | `5000` | Максимальная задержка backoff. |
| `PROVIDER_RETRY_MAX_AFTER_MS` | `30000` | `Retry-After` больше этого значения не ожидается — сразу 429. |

При добавлении нового внешнего API домен нужно внести в allowlist, иначе запрос завершится `errors.outbound_blocked`.

### 3.8. Sandbox

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `TAVILY_API_KEY` | `mock_key` | Ключ Tavily для `check_facts`; передается в sandbox. |
| `GITHUB_TOKEN` | `mock_token` | Токен GitHub для навыков, которым нужен API. |
| `SANDBOX_SECCOMP_PROFILE` | пусто | Путь к seccomp-профилю внутри `sandbox-worker`; пусто — профиль Docker по умолчанию. В staging обязателен. |

Egress песочницы задается полем `egress_allowlist` в манифесте навыка (deny by default); глобального флага включения сети нет.

### 3.9. MCP и маркетплейсы

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `OZON_CLIENT_ID` | пусто | Client ID Ozon Seller API. |
| `OZON_API_KEY` | пусто | Api-Key Ozon Seller API. |
| `OZON_PERF_CLIENT_ID` | пусто | Client ID Ozon Performance API (реклама). |
| `OZON_PERF_CLIENT_SECRET` | пусто | Client Secret Ozon Performance API. |
| `WB_API_TOKEN` | пусто | Токен Wildberries Seller/Marketplace и Pricing API. |
| `MCP_AUTH_TOKEN` | пусто | Общий Bearer-токен для `/sse` MCP-серверов; пусто — без авторизации. |
| `MCP_ALLOW_MISSING_KEYS` | `0` | `0` — healthcheck MCP требует ключи Ozon/WB; `1` — разрешает пустые ключи. |
| `OZON_API_BASE_URL` | `https://api-seller.ozon.ru` | Хост Ozon Seller API. |
| `OZON_API_TEST_PATH` | `/v1/product/import/prices` | Тестовый write-метод для `scripts/test-integrations.sh`. |
| `OZON_PERFORMANCE_API_BASE_URL` | `https://api-performance.ozon.ru` | Хост Ozon Performance API. |
| `WB_PRICING_API_BASE_URL` | `https://discounts-prices-api.wildberries.ru` | Отдельный хост WB Pricing API. |
| `WB_API_TEST_PATH` | `/ping` | Проверка токена WB. |

### 3.10. OCR и документы

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `OCR_API_URL` | пусто | Полный URL распознавания SDE-совместимого сервиса; пусто — только Tesseract. |
| `OCR_API_KEY` | пусто | Ключ OCR-сервиса. |
| `OCR_API_AUTH_HEADER` | `Authorization` | Заголовок авторизации. |
| `OCR_API_AUTH_PREFIX` | `Bearer` | Префикс схемы; для `Api-Key` задайте `Api-Key`. |
| `OCR_API_TIMEOUT_MS` | `60000` | Таймаут запроса распознавания. |
| `OCR_MAX_POLL_ATTEMPTS` | `10` | Попытки опроса асинхронной задачи. |
| `OCR_POLL_INTERVAL_MS` | `2000` | Интервал опроса. |
| `OCR_TESSERACT_ENABLED` | `true` | Локальный fallback через Tesseract в sandbox. |
| `OCR_TESSERACT_LANG` | `rus+eng` | Языки Tesseract. |
| `OCR_MAX_IMAGE_BYTES` | `8388608` | Максимальный размер изображения (8 MB). |
| `DOCUMENTS_INPUT_DIR` | `./documents` | Каталог входных файлов document-инструментов. |
| `DOCUMENTS_OUTPUT_DIR` | `./docx-output` | Каталог результатов `write_docx`. |
| `DOCUMENTS_MAX_BYTES` | `10485760` | Максимальный размер входного файла (10 MB). |
| `DOCUMENTS_MAX_PAGES` | `50` | Максимум страниц PDF. |
| `DOCUMENTS_MAX_TEXT_CHARS` | `100000` | Максимум символов текста в ответе инструмента. |

Каталоги `DOCUMENTS_*` должны быть смонтированы в контейнер API, иначе инструменты видят пустой каталог.

### 3.11. Midjourney (TTAPI)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `MIDJOURNEY_API_KEY` | пусто | Ключ TTAPI; единственный разрешенный провайдер Midjourney. |
| `MIDJOURNEY_POLL_INTERVAL_MS` | `2000` | Интервал опроса задачи. |
| `MIDJOURNEY_TIMEOUT_MS` | `120000` | Таймаут генерации. |
| `MIDJOURNEY_TEST_PATH` | `/midjourney/v1/fetch?jobId=test` | Тестовый запрос для `scripts/test-integrations.sh`. |
| `MIDJOURNEY_TEST_METHOD` | `GET` | HTTP-метод тестового запроса. |

### 3.12. Production, мониторинг, бэкапы и observability

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `DOMAIN` | `skillwharf.example.com` | Домен для Caddy и HTTPS. |
| `ACME_EMAIL` | `admin@example.com` | Email для ACME. |
| `ACME_CA` | staging URL Let's Encrypt | ACME CA; для боевого сертификата укажите production URL. |
| `VITE_RAG_MEMORY_ENABLED` | закомментирована | Включает раздел «Память» в Docker-сборке; значение вшивается при сборке, после изменения нужен `docker compose build web`. |
| `MONITORING_BASIC_AUTH_USER` | `monitoring` | Логин Basic Auth для Prometheus и путей `/grafana/`, `/prometheus/`. |
| `MONITORING_BASIC_AUTH_PASSWORD` | пусто | Пароль Basic Auth; обязателен для профиля `monitoring`, без символа `$`. |
| `MONITORING_BASIC_AUTH_HASH` | пусто | bcrypt-хэш того же пароля; обязателен для профиля `monitoring`. |
| `GRAFANA_ADMIN_USER` | `admin` | Логин администратора Grafana. |
| `GRAFANA_ADMIN_PASSWORD` | пусто | Пароль администратора Grafana; обязателен, `admin/admin` не используется. |
| `BACKUP_KEEP_DAYS` | `14` | Сколько дней хранить дампы. |
| `BACKUP_KEEP_MIN` | `7` | Минимум последних дампов, которые всегда остаются. |
| `BACKUP_MIN_FREE_MB` | `512` | Минимум свободного места перед дампом. |
| `BACKUP_S3_ENDPOINT` | пусто | S3-совместимый endpoint для offsite-бэкапов. |
| `BACKUP_S3_BUCKET` | пусто | Бакет offsite; пусто — offsite выключен. |
| `BACKUP_S3_REGION` | пусто | Регион S3. |
| `BACKUP_S3_ACCESS_KEY` | пусто | Access key S3. |
| `BACKUP_S3_SECRET_KEY` | пусто | Secret key S3. |
| `BACKUP_S3_PREFIX` | пусто | Префикс объектов в бакете. |
| `BACKUP_S3_KEEP_DAYS` | пусто | Retention offsite; пусто — равно `BACKUP_KEEP_DAYS`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | пусто | OTLP-endpoint; пусто — OTel SDK не запускается. Для локального коллектора: `http://otel-collector:4318`. |
| `OTEL_SERVICE_NAME` | `skillwharf-api` | Имя сервиса в спанах. |
| `SENTRY_DSN` | пусто | DSN Sentry; пусто — Sentry выключен. |
| `SENTRY_ENVIRONMENT` | `development` | Окружение в событиях Sentry. |
| `SENTRY_RELEASE` | пусто | Релиз (обычно git SHA). |

## 4. Получение и настройка API-ключей

Для полноценной работы понадобятся ключи перечисленных сервисов. Заполняйте их в `.env` или через интерфейс «Интеграции»; ключи Ozon/WB/Midjourney, сохраненные через UI, хранятся per-user в зашифрованном виде.

### 4.1. LLM-провайдеры (обязательно)

- **GigaChat:** Зарегистрируйтесь в [Sber Developer](https://developers.sber.ru/portal/products/gigachat). Создайте проект, получите `GIGACHAT_CLIENT_ID` и `GIGACHAT_CLIENT_SECRET`; OAuth-токен адаптер получает и кэширует сам.
- **YandexGPT (Yandex AI Studio):** В [Yandex Cloud](https://console.cloud.yandex.ru/) создайте каталог и сервисный аккаунт с ролью `ai.languageModels.user`. Укажите `YANDEX_FOLDER_ID` и либо `YANDEX_OAUTH_TOKEN` (автообновление IAM), либо статический `YANDEX_IAM_TOKEN` (живет 12 часов).
- **OpenAI-совместимые (LM Studio/Ollama/vLLM):** Укажите `LLM_BASE_URL` (например, `http://ollama:11434/v1`), `LLM_API_KEY` и `LLM_MODEL`.
- **Эмбеддинги (опционально):** `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`. Если модель не задана, долговременная память отключена.

### 4.2. ЮKassa (обязательно для приема платежей)

- В [Личном кабинете ЮKassa](https://yookassa.ru/my) откройте «Настройки» → «Магазин» → «API-ключи» и получите `shopId` и секретный ключ. Заполните `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY`. Без ключей работает mock-провайдер.
- Задайте `YOOKASSA_RETURN_URL` — адрес возврата после оплаты (по умолчанию `http://localhost:8080/app/chat?payment=success`).
- Настройте HTTP-уведомления на `https://<ваш-домен>/api/v1/billing/webhook` для события `payment.succeeded`. Webhook публичный (без JWT), перед зачислением API перепроверяет платеж запросом к ЮKassa, а идемпотентность обеспечивает ключ `yookassa:<paymentId>`; остальные события подтверждаются кодом 200 и пропускаются.

### 4.3. Ozon (треки C и J)

- **Seller API:** В личном кабинете [Seller Ozon](https://seller.ozon.ru/) откройте «Настройки» → «API-ключи» и создайте ключ: `Client ID` и `Api-Key`. Заполните `OZON_CLIENT_ID` и `OZON_API_KEY`.
- **Performance API (реклама):** В кабинете Ozon Performance создайте отдельные `Client ID`/`Secret` и заполните `OZON_PERF_CLIENT_ID` и `OZON_PERF_CLIENT_SECRET`. Запросы идут только на `https://api-performance.ozon.ru`; старый `performance.ozon.ru` не используется.
- **Актуальные методы 2026:** начисления читаются через `/v1/finance/accrual/by-day`; `/v3/finance/transaction/list` отключен Ozon и напрямую не вызывается (MCP-сервер пересобирает операции по дням). Цены читаются `/v5/product/info/prices`, импорт цен — `/v1/product/import/prices` (используется только тестом с пустым телом).
- **Проверка:** `bash scripts/test-integrations.sh --ozon`. Ответ 400/422 на пустое тело означает, что ключ принят; 401/403 — ошибка ключа.

### 4.4. Wildberries (треки C и J)

- В [WB Seller](https://seller.wildberries.ru/) откройте «Настройки» → «Доступ к API» и создайте токен. Отметьте категории «Контент», «Цены и скидки», «Заказы». Заполните `WB_API_TOKEN`.
- Токен действует 180 дней; отдельного API-поля срока действия нет — фиксируйте дату создания в кабинете. При подключении через UI платформа сохраняет `tokenExpiresAt` (+180 дней).
- Pricing API живет на отдельном хосте `https://discounts-prices-api.wildberries.ru` (не `marketplace-api.wildberries.ru`), переменная `WB_PRICING_API_BASE_URL`.
- **Проверка:** `bash scripts/test-integrations.sh --wb` (запрос `GET /ping` на Pricing-хосте).

### 4.5. Telegram (треки A, B, E, G)

- Напишите `@BotFather` в Telegram и создайте бота командой `/newbot`. Получите `TELEGRAM_BOT_TOKEN`.
- Сгенерируйте секрет webhook (`openssl rand -hex 32`) и заполните `TELEGRAM_WEBHOOK_SECRET`. Лимит запросов на IP — `TELEGRAM_WEBHOOK_RATE_LIMIT` (по умолчанию 120 в минуту).
- Зарегистрируйте webhook на `https://<домен>/api/v1/webhooks/telegram`, передав `secret_token`, либо вызовите `POST /api/v1/integrations/telegram/webhook/register` с `{"publicUrl":"https://<домен>/api/v1/webhooks/telegram"}`.
- Привяжите чат пользователя через `POST /api/v1/integrations/telegram/link` с `{"chatId":"<id>"}`.

### 4.6. Google Workspace (треки A, B, E, G)

- В [Google Cloud Console](https://console.cloud.google.com/) создайте проект и включите Google Sheets API, Google Docs API и Google Calendar API.
- Настройте OAuth consent screen (Internal или Testing) и создайте OAuth client типа **Web application**.
- В Authorized redirect URI добавьте значение `GOOGLE_REDIRECT_URI`; оно должно совпадать посимвольно, иначе Google вернет `redirect_uri_mismatch`:

  ```text
  https://<domain>/api/v1/integrations/google/callback
  ```

- Заполните `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. При необходимости задайте `GOOGLE_OAUTH_SCOPES`, `GOOGLE_CALENDAR_ID` и `GOOGLE_OAUTH_SUCCESS_REDIRECT`.
- Сгенерируйте `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) и укажите `TOKEN_ENCRYPTION_KEY_ID`. Refresh/access-токены хранятся в БД зашифрованными; в production держите ключ в Docker secret или менеджере секретов.
- Пользователь подключает Google в «Настройки» → «Интеграции»; статус проверяется через `GET /api/v1/integrations/google/status`.
- Если consent screen остается в Testing, доступ есть только у добавленных test users; для реальных пользователей переведите приложение в рабочее состояние.

### 4.7. Midjourney (TTAPI)

- Официального API Midjourney нет. По аудиту ноября 2026 разрешен только **TTAPI**; GoAPI/UseAPI и Discord-обертки не используются.
- Зарегистрируйтесь на [TTAPI](https://api.ttapi.io/), пополните баланс и получите ключ. Заполните `MIDJOURNEY_API_KEY`; заголовок `TT-API-KEY` платформа подставляет сама.
- Эндпоинты зафиксированы в коде: `POST https://api.ttapi.io/midjourney/v1/imagine` и `GET https://api.ttapi.io/midjourney/v1/fetch?jobId=<jobId>`. Домен `api.ttapi.io` уже включен в `API_OUTBOUND_ALLOWLIST`; другие домены Midjourney не добавляйте.
- **Проверка:** `bash scripts/test-integrations.sh --midjourney` (запрос `fetch?jobId=test`; 404/2xx — ключ принят, 401 — отклонен). TTAPI не дает официального SLA.

### 4.8. Tavily (фактчекинг)

Зарегистрируйтесь на [Tavily](https://tavily.com/), получите `TAVILY_API_KEY` и заполните его в `.env`. Домен `api.tavily.com` уже включен в `API_OUTBOUND_ALLOWLIST`.

### 4.9. OCR (Smart Document Engine)

- Основной путь — SDE-совместимый HTTP API (on-prem или облачный). Укажите полный URL эндпоинта в `OCR_API_URL` и ключ в `OCR_API_KEY`.
- Контракт: `POST {content: <base64>, mimeType, language}` → `{text}`; поддерживаются ответы `result.text`, `result.textAnnotation.fullText`, `data.text`, `pages[].text` и асинхронный режим `{status: "processing", taskId}`.
- Авторизация по умолчанию — `Authorization: Bearer <key>`. Для схемы `Api-Key` задайте `OCR_API_AUTH_PREFIX=Api-Key`, для нестандартного заголовка — `OCR_API_AUTH_HEADER`.
- Прямой Yandex Vision API с этим контрактом не работает: ему нужны `x-folder-id` и `languageCodes` (KI-071). Используйте SDE-совместимый прокси/сервис.
- Без `OCR_API_URL` работает локальный Tesseract (`OCR_TESSERACT_ENABLED=true`, языки `OCR_TESSERACT_LANG`), внешняя сеть не нужна.
- **Проверка:** `bash scripts/test-integrations.sh --ocr` и `bash scripts/test-documents.sh`.

## 5. Проверка работоспособности

1. **Healthcheck API:**

   ```bash
   curl http://localhost:3001/api/v1/health/ready
   ```

   Ожидаемый ответ: `{"status":"ok","database":true}`.

2. **Веб-UI:** откройте `http://localhost:8080` — должна загрузиться страница входа.

3. **Тесты интеграций:**

   ```bash
   bash scripts/test-integrations.sh
   ```

   Скрипт проверяет Ozon, Wildberries, Midjourney (TTAPI) и OCR. Без ключей проверка пропускается (SKIP), с неверным ключом — FAIL; секреты не печатаются.

4. **Документы и sandbox:**

   ```bash
   bash scripts/test-documents.sh
   ```

   Smoke-тест Tesseract, `pdftotext` и `pandoc` в образе `skillwharf-sandbox`.

5. **Мониторинг:** перед запуском профиля `monitoring` заполните `MONITORING_BASIC_AUTH_USER`, `MONITORING_BASIC_AUTH_PASSWORD`, `MONITORING_BASIC_AUTH_HASH` и `GRAFANA_ADMIN_PASSWORD`. Без них профиль не стартует.

   ```bash
   docker compose --profile monitoring up -d
   ```

   Grafana — `http://localhost:3003`, Prometheus — `http://localhost:9090`. Войдите в Grafana с `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` и откройте дашборд `SkillWharf Overview`.

## 6. Первый вход

Откройте `http://localhost:8080` и зарегистрируйте первого пользователя. Назначьте ему роль `admin`:

```bash
docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
UPDATE "User" SET role = 'admin' WHERE email = 'admin@example.com';
SQL
```

Либо используйте Prisma Studio. Затем перейдите в **Пульт управления** (`/admin`) для настройки LLM-маршрутов и просмотра аудита.

## 7. Диагностика проблем

### 7.1. Контейнер `db-migrate` завершился с ошибкой

API не стартует, потому что ждет `service_completed_successfully`. Сначала посмотрите статус и логи:

```bash
docker compose ps -a db-migrate
docker compose logs --tail=200 db-migrate
```

Успешное завершение — строка `All migrations have been successfully applied` и статус `Exited (0)`. Частые причины: неверный `DATABASE_URL`, нет прав на схему, конфликтующая или частично примененная миграция.

Исправьте причину и повторите миграции:

```bash
docker compose up -d --force-recreate db-migrate
docker compose logs -f db-migrate
docker compose up -d api
```

**Откат миграции.** В Prisma нет автоматических down-миграций, а `prisma migrate reset` в production удалит данные — не используйте его. Безопасный порядок:

1. Остановите API и LLM-Worker, чтобы не было записи в БД:

   ```bash
   docker compose stop api llm-worker
   ```

2. Сделайте бэкап:

   ```bash
   bash scripts/backup-db.sh
   ```

3. Найдите проблемную миграцию:

   ```bash
   docker compose exec postgres sh -c \
     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"'
   ```

4. Если миграция применилась частично, вручную откатите ее SQL. Составьте обратные операции по `apps/api/prisma/migrations/<migration_name>/migration.sql` и выполните их в транзакции:

   ```bash
   docker compose exec -T postgres sh -c \
     'psql -1 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
     < rollback.sql
   ```

   Если откатить SQL нельзя, восстановите БД из дампа по инструкции Runbook (крайняя мера, возможна потеря данных после бэкапа).

5. Отметьте миграцию как откаченную и повторите deploy:

   ```bash
   docker compose run --rm --entrypoint prisma db-migrate \
     migrate resolve --rolled-back <migration_name>
   docker compose up -d --force-recreate db-migrate
   docker compose logs -f db-migrate
   docker compose up -d api llm-worker
   ```

   Перед повтором убедитесь, что миграция исправлена: `migrate deploy` применит ее заново.

Если миграция уже применена и ломает приложение, исправляйте ее новой миграцией вперед, а не откатом в production.

### 7.2. API не видит Redis (`finance.snapshots.redis_unavailable`)

В логах API появляются `finance.snapshots.redis_unavailable` и `finance.snapshots.redis_fallback`. Финансовый дашборд продолжает работать на памяти процесса API: после перезапуска снапшоты теряются, а в multi-replica окружении данные одной реплики не видны другой.

Проверка:

```bash
docker compose ps redis
docker compose logs --tail=100 redis
docker compose exec redis redis-cli ping
docker compose exec api printenv REDIS_URL
docker compose exec redis redis-cli --scan --pattern 'finance:snapshots:*'
```

Ожидаемо: контейнер `running`, `ping` возвращает `PONG`, `REDIS_URL=redis://redis:6379`, ключи вида `finance:snapshots:<userId>`.

Типичные причины и исправление:

- Redis не запущен — `docker compose up -d redis`, затем `docker compose up -d --force-recreate api`.
- Неверный `REDIS_URL` — внутри compose должен быть `redis://redis:6379`; порт Redis наружу не публикуется, с хоста проверяйте через `docker compose exec redis`.
- Redis перезапускался с потерей данных — проверьте том `redis_data` и `appendonly yes`; снапшоты восстановятся после следующего запуска финансового инструмента в чате.
- Снапшоты истекли — это не ошибка: TTL задает `FINANCE_SNAPSHOT_TTL_SECONDS` (по умолчанию 7 суток), после чего дашборд показывает `dataAvailable: false`.

После устранения причины пересоздайте API, чтобы он переподключился к Redis.

### 7.3. Нет логов OTel-коллектора и трассировок в Grafana

1. Включите экспорт в `.env`:

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   OTEL_SERVICE_NAME=skillwharf-api
   ```

2. Поднимите коллектор (профиль `monitoring`) и пересоздайте API, чтобы он прочитал env:

   ```bash
   docker compose --profile monitoring up -d otel-collector
   docker compose up -d api
   ```

3. Смотрите логи коллектора и сгенерируйте трафик:

   ```bash
   docker compose logs -f otel-collector
   curl -fsS http://localhost:3001/api/v1/health/ready
   ```

   В логах должны появиться `service.name=skillwharf-api`, HTTP/Nest-спаны и атрибуты `gen_ai.*`. OTLP-порты `4317`/`4318` опубликованы только на `127.0.0.1`; конфигурация — `infra/otel/otel-collector.yml`. По умолчанию коллектор печатает трейсы в stdout и не отправляет их во внешние SaaS.

4. Метрики и дашборды в Grafana:

   ```bash
   docker compose --profile monitoring up -d
   ```

   Откройте `http://localhost:3003`, войдите с `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` и выберите дашборд `SkillWharf Overview`. Prometheus доступен на `http://localhost:9090` и скрейпит `api:3000/metrics`.

   Grafana в текущей конфигурации показывает метрики Prometheus, а не спаны: трейсы смотрите в логах `otel-collector` (Tempo/Jaeger не подключены).

Если спанов нет:

- `OTEL_EXPORTER_OTLP_ENDPOINT` пуст или API не пересоздан после изменения `.env`;
- коллектор не запущен (нужен профиль `monitoring`);
- порты `4317`/`4318` заняты другим процессом (`docker compose logs otel-collector`);
- панели стоимости `llm_cost_total` пусты, пока не выполнен хотя бы один вызов LLM: Counter создает серию только после первого инкремента.

Откат observability: очистите `OTEL_EXPORTER_OTLP_ENDPOINT` и выполните `docker compose up -d api`; коллектор можно остановить через `docker compose stop otel-collector`. API продолжит работать без трейсов.

## 8. Что дальше

- Полный runbook: [`docs/operations/Deployment-Runbook.md`](docs/operations/Deployment-Runbook.md).
- Известные ограничения: [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).
- История изменений: [`docs/CHANGELOG.md`](docs/CHANGELOG.md).
