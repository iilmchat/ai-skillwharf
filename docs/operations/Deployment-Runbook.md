# Runbook: Развёртывание SkillWharf (On-Premise)

**Статус:** Утверждено
**Дата:** 2026-11-12

## 1. Системные требования

* **ОС:** Linux (Ubuntu 22.04+ / Debian 12+).
* **CPU:** x86_64 с поддержкой аппаратной виртуализации (Intel VT-x / AMD-V) для запуска Firecracker (Sandbox).
* **RAM:** Минимум 8 GB (рекомендуется 16 GB для LLM и агентов).
* **Диск:** 50 GB SSD.
* **ПО:** Docker 24+, Docker Compose v2, PostgreSQL 15+ (если не используется встроенный контейнер).

## 2. Переменные окружения (.env)

Перед запуском создайте файл `.env` в корне проекта на основе `.env.example`:

* `POSTGRES_PASSWORD`: Надежный пароль для БД.
* `DATABASE_URL`: Строка подключения Prisma к PostgreSQL (по умолчанию порт хоста `5435`, см. `.env.example`).
* `JWT_SECRET`: Секрет для подписи токенов (минимум 32 символа).
* `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`: Подключение к LLM по OpenAI-совместимому API (по умолчанию — локальный Ollama, см. раздел 4).
* `GIGACHAT_CLIENT_ID` / `GIGACHAT_CLIENT_SECRET`: Ключи для российских LLM (опционально).
* `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY`: Ключи для биллинга (если включен).
* `KVM_DEVICE_PATH`: Путь к устройству KVM (обычно `/dev/kvm`).

## 3. Шаги развертывания (Docker Compose)

1. **Клонирование репозитория:**

   ```bash
   git clone https://github.com/iilmchat/ai-skillwharf.git
   cd ai-skillwharf
   ```

2. **Подготовка окружения:**

   ```bash
   cp .env.example .env
   # Отредактируйте .env, задав пароли и ключи
   ```

3. **Запуск стека:**

   ```bash
   docker compose up -d --build
   ```

   Миграции применяются автоматически при старте контейнера через `entrypoint.sh`.

   > **Внимание (масштабирование):** при запуске API в нескольких репликах не
   > полагайтесь на `entrypoint.sh` — каждая реплика выполнит
   > `prisma migrate deploy` параллельно. Используйте отдельный Init-Container
   > (или Kubernetes Job), который применяет миграции и завершается до старта
   > реплик API. Подробнее — KI-007 в `docs/KNOWN_ISSUES.md`.

4. **Проверка статуса:**

   ```bash
   curl http://localhost:3001/api/v1/health
   # Ожидаемый ответ: {"status":"ok","database":true}
   ```

   > Порты `3000` и `5432` на хосте заняты другими проектами, поэтому API
   > проброшен на `3001`, а PostgreSQL — на `5435` (см. `docker-compose.yml`).

## 4. Настройка LLM

API общается с моделями по OpenAI-совместимому API: адрес, ключ и имя модели
задаются в `.env` переменными `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
(значения по умолчанию — из `.env.example`).

### Локальная модель (Ollama)

Сервис `ollama` вынесен в профиль `with-llm`, поэтому не запускается вместе с
основным стеком и не расходует RAM:

```bash
docker compose --profile with-llm up -d ollama
docker compose exec ollama ollama run llama3
```

Сервис `api` в compose-сети видит Ollama по имени `ollama`:

```text
LLM_BASE_URL=http://ollama:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=llama3
```

> Порт `11434` на хосте обычно занят локальным Ollama, поэтому контейнер
> проброшен на `11435`: с хоста (`pnpm start:dev`) используйте
> `LLM_BASE_URL=http://localhost:11435/v1`. Если Ollama установлен на хосте, а
> не в контейнере, оставьте `LLM_BASE_URL=http://localhost:11434/v1`.

После изменения переменных перезапустите API:

```bash
docker compose up -d api
```

### Настройка LM Studio через Control Plane

LM Studio запускается на хосте и отдаёт OpenAI-совместимый API. Маршрут
хранится в БД (`LlmRoute`), поэтому модель, адрес и приоритет можно менять
без перезапуска API.

1. В LM Studio откройте вкладку **Developer**, загрузите модель
   `qwen2.5-coder-7b-instruct` и нажмите **Start Server**. Порт — `8034`,
   доступ по сети должен быть разрешён.
2. Добавьте в `.env` адрес и ключ LM Studio:

   ```text
   LLM_BASE_URL=http://host.docker.internal:8034/v1
   LLM_API_KEY=<ключ из настроек LM Studio>
   LLM_MODEL=qwen2.5-coder-7b-instruct
   ```

3. Перезапустите API:

   ```bash
   docker compose up -d api
   ```

   В `docker-compose.yml` у сервиса `api` уже объявлен `extra_hosts` с
   `host.docker.internal:host-gateway`: на Linux это открывает доступ к хосту,
   на Windows и macOS `host.docker.internal` работает из коробки.

4. Получите JWT администратора (`POST /api/v1/auth/login`) и создайте маршрут
   через Control Plane:

   ```bash
   curl -X POST http://localhost:3001/api/v1/admin/llm-routes \
     -H "Authorization: Bearer <JWT_АДМИНА>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "local-qwen-coder",
       "modelName": "qwen2.5-coder-7b-instruct",
       "baseUrl": "http://host.docker.internal:8034/v1",
       "apiKeyEnvVar": "LLM_API_KEY",
       "priority": 1,
       "isActive": true
     }'
   ```

   `apiKeyEnvVar` хранит только имя переменной окружения: сам ключ остаётся
   в `.env` и не попадает в БД. Маршрут с наименьшим `priority` среди активных
   используется первым; env-переменные `LLM_*` остаются fallback-вариантом.

5. Проверьте маршрут и чат:

   ```bash
   curl -s http://localhost:3001/api/v1/admin/llm-routes \
     -H "Authorization: Bearer <JWT_АДМИНА>"
   ```

   Затем отправьте сообщение в чат: ответ должен прийти от Qwen, а не от
   заглушки.

> Если контейнер не видит `host.docker.internal`, укажите IP хоста вручную:
> на Linux это обычно `http://172.17.0.1:8034/v1` (проверьте
> `ip addr show docker0`). Тот же адрес используйте в `baseUrl` маршрута.

### Внешняя модель (GigaChat / YandexGPT и др.)

Укажите в `.env` OpenAI-совместимый эндпоинт провайдера (или прокси перед ним),
ключ и имя модели:

```text
LLM_BASE_URL=https://llm.example.ru/v1
LLM_API_KEY=<ключ провайдера>
LLM_MODEL=<имя модели>
```

Для GigaChat клиентские ключи `GIGACHAT_CLIENT_ID` / `GIGACHAT_CLIENT_SECRET`
описаны в разделе 2. После изменения переменных перезапустите API
(`docker compose up -d api`).

## 5. Бэкап и восстановление (Ledger и БД)

Для предотвращения потери данных биллинга (Ledger) необходимо регулярно делать бэкап PostgreSQL.

**Создание бэкапа:**

```bash
docker compose exec -T postgres pg_dump -U skillwharf_admin -d skillwharf_db -Fc > backup_$(date +%Y%m%d).dump
```

**Восстановление:**

```bash
docker compose exec -T postgres pg_restore -U skillwharf_admin -d skillwharf_db --clean < backup_20261112.dump
```

## 6. Диагностика проблем

* **Ошибка: `KVM device not found`**
  * *Решение:* Убедитесь, что хост-система поддерживает виртуализацию (`egrep -c '(vmx|svm)' /proc/cpuinfo` > 0) и модуль KVM загружен (`lsmod | grep kvm`). Если развертывание в облаке, используйте инстансы с поддержкой вложенной виртуализации.
* **Ошибка: `Connection refused` при вызове LLM.**
  * *Решение:* Проверьте доступность API LLM-провайдера из контейнера (`docker compose exec api curl ...`).

## 7. Безопасность Sandbox

Код выполняется в отдельном сервисе `sandbox-worker`
(`apps/sandbox-worker`). Только этот сервис получает `/var/run/docker.sock`;
в API сокет не монтируется. API вызывает worker по HTTP:

```text
POST http://sandbox-worker:4000/execute
```

Адрес задаётся переменной `SANDBOX_WORKER_URL` (по умолчанию
`http://sandbox-worker:4000`).

### Worker

* Express-сервер на порту `4000`, порт не публикуется на хост.
* Ограничения контейнера: read-only rootfs, `cap_drop: ALL`,
  `no-new-privileges`, 128 МБ памяти, 0.5 CPU.
* Сеть по умолчанию `none`; `bridge` включается только по флагу
  `ALLOW_NETWORK=true` или `SANDBOX_ALLOW_NETWORK=true`.
* Worker запускается от root: GID `docker.sock` зависит от хоста. API при этом
  остаётся непривилегированным и не имеет доступа к Docker.

### Production

Монтировать `/var/run/docker.sock` в API **запрещено**: доступ к сокету
эквивалентен root-доступу к хосту. Сокет должен быть только у
`sandbox-worker`, а порт `4000` — доступен только внутри compose-сети.
Для строгой изоляции замените worker на удалённый Firecracker/gVisor
provider.

### Локальная разработка

`sandbox-worker` входит в базовый `docker-compose.yml`, поэтому достаточно:

```bash
docker compose up -d --build
```

На Windows/macOS с Docker Desktop сокет доступен по
`/var/run/docker.sock`. На Linux используется тот же путь; при нестандартном
расположении сокета задайте `DOCKER_SOCKET` и смонтируйте его в
`sandbox-worker`.

Файл `docker-compose.sandbox-dev.yml` больше не нужен: он оставлен пустым
для совместимости старых команд и не даёт API доступ к сокету.

CI собирает базовый образ API и отдельный образ `sandbox-worker`
(`docker compose build sandbox-worker`).

## 8. Настройка биллинга

Для локальной разработки в `.env` используются mock-значения из
`.env.example`:

```text
# Billing (YooKassa Mock)
YOOKASSA_SHOP_ID=mock_shop_id
YOOKASSA_SECRET_KEY=mock_secret_key
YOOKASSA_RETURN_URL=http://localhost:3001/billing/success
```

### Реальные ключи ЮKassa

1. Получите `shopId` и секретный ключ в личном кабинете ЮKassa
   (раздел «Настройки» → «Магазин» → API-ключи).
2. Пропишите их в `.env`:

   ```text
   YOOKASSA_SHOP_ID=<shopId из личного кабинета>
   YOOKASSA_SECRET_KEY=<секретный ключ>
   YOOKASSA_RETURN_URL=https://<домен>/billing/success
   ```

3. Перезапустите API, чтобы он перечитал переменные:

   ```bash
   docker compose up -d api
   ```

> Секретный ключ ЮKassa — это платёжный секрет. Не коммитьте `.env` и не
> передавайте ключ в открытом виде; в production используйте секрет-хранилище.

### Проверка пополнения и списания

Миграции (включая триггеры append-only для Ledger) применяются автоматически
при старте контейнера через `entrypoint.sh`.

Эндпоинты требуют JWT администратора (`Authorization: Bearer <token>`).

**Пополнение баланса (админка):**

```bash
curl -X POST http://localhost:3001/api/v1/billing/topup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uuid>","amount":500.00,"description":"Пополнение баланса","idempotencyKey":"topup-001"}'
```

**Списание за вызов Skill:**

```bash
curl -X POST http://localhost:3001/api/v1/billing/charge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uuid>","amount":10.00,"description":"Списание за вызов Skill","idempotencyKey":"charge-001"}'
```

`idempotencyKey` обязателен: повторный запрос с тем же ключом не создаёт
вторую запись в Ledger. Баланс кошелька можно проверить через
`GET /api/v1/billing/balance`.

Записи Ledger неизменяемы: миграция создаёт триггеры, которые запрещают
`UPDATE` и `DELETE` для `LedgerEntry`.

## 9. Локализация

Интерфейс поддерживает русский (RU) и английский (EN) языки. Язык
переключается в интерфейсе, выбор пользователя сохраняется в браузере и
переопределяет значение по умолчанию.

Язык по умолчанию задаётся переменной окружения:

```text
DEFAULT_LANGUAGE=ru
```

Допустимые значения — `ru` и `en`; если переменная не задана, используется
`ru`. Для англоязычной инсталляции укажите `DEFAULT_LANGUAGE=en` в `.env` и
перезапустите API:

```bash
docker compose up -d api
```

Непереведённые строки откатываются к русскому языку.

## 10. Production: HTTPS с Caddy

Локальный сервис `web` слушает HTTP `:80` (на хосте — `8080`) и проксирует
`/api` и `/socket.io` на `api:3000`. Для production в compose добавлен
отдельный edge-контейнер `caddy` под профилем `production`: он терминирует
TLS, автоматически получает сертификаты Let's Encrypt и передаёт запросы на
`web:80`.

### Подготовка

1. Направьте A/AAAA-запись домена (например, `skillwharf.example.com`) на
   хост и откройте входящие порты `80` и `443`.
2. Задайте домен и e-mail для ACME в `.env`:

   ```text
   DOMAIN=skillwharf.example.com
   ACME_EMAIL=admin@example.com
   ```

3. Убедитесь, что наружу не опубликованы лишние порты. В production должны
   быть доступны только `80` и `443`; `8080` (web) и `3001` (api) закройте
   файрволом или не публикуйте в production-оверрайде.

### Запуск

```bash
docker compose --profile production up -d --build
```

Caddy запустится вместе с базовым стеком, запросит сертификат для `DOMAIN` и
включит автоматический редирект с HTTP на HTTPS.

### Проверка

```bash
curl -I https://skillwharf.example.com
curl -I http://skillwharf.example.com
curl https://skillwharf.example.com/api/v1/health
```

Ожидаемо: HTTPS отвечает `200`, HTTP — редирект `308` на HTTPS, healthcheck
возвращает `{"status":"ok","database":true}`.

WebSocket (`/socket.io/`) идёт через тот же домен: edge-Caddy проксирует
запрос на `web:80`, а `web` — на `api:3000` с сохранением заголовков
`Upgrade`/`Connection`.

> Сертификаты и ACME-аккаунт хранятся в volume `caddy_data`, конфигурация —
> в `caddy_config`. Не удаляйте `caddy_data` при перезапуске, иначе Caddy
> запросит сертификаты повторно и может упереться в лимиты Let's Encrypt.

## 11. Тестирование

### E2E-тесты (Playwright)

Сквозные сценарии лежат в `apps/web/e2e` и запускаются против уже
поднятого стека. Проверяются страница входа, отправка сообщения в чат и
установка навыка из магазина.

1. Установите зависимости и браузер:

   ```bash
   pnpm install
   pnpm exec playwright install --with-deps chromium
   ```

2. Поднимите стек и дождитесь healthcheck:

   ```bash
   docker compose up -d --build
   curl http://localhost:8080/api/v1/health
   ```

3. Для детерминированного ответа чата отключите внешнюю LLM — API вернёт
   эхо-заглушку. В `.env`:

   ```text
   LLM_BASE_URL=
   LLM_MODEL=
   ```

   Затем перезапустите API: `docker compose up -d api`. Если LLM настроена и
   доступна, тест всё равно пройдёт — он проверяет факт ответа, а не его текст.

4. Запустите тесты:

   ```bash
   pnpm exec playwright test
   ```

Тестовый пользователь `e2e@skillwharf.test` создаётся автоматически через
`POST /api/v1/auth/register` и получает стартовый баланс через
`POST /api/v1/billing/topup`; отдельный сид не нужен. Для локального стека
тест повышает пользователя до `admin` и удаляет ранее установленный
`weather-api`, чтобы установка из магазина проверялась при каждом прогоне.

## 12. Наблюдаемость (AgentOps)

API пишет OTel-совместимые события в лог приложения. Пока это JSON в stdout;
те же атрибуты можно позже отправить в OTLP-коллектор без изменения кода.

**Вызов LLM** (`apps/api/src/llm/llm.service.ts`) — одна запись на каждый
ответ модели:

```json
{
  "event": "gen_ai.usage",
  "gen_ai.system": "openai",
  "gen_ai.model": "qwen2.5-coder-7b-instruct",
  "gen_ai.prompt_tokens": 128,
  "gen_ai.completion_tokens": 42
}
```

**Запуск агента** (`apps/api/src/chat/chat.service.ts`) — запись перед
обработкой сообщения:

```json
{
  "event": "gen_ai.agent.run",
  "gen_ai.agent.id": "nova",
  "gen_ai.tenant.id": "<user-id>",
  "conversationId": "<conversation-id>"
}
```

Как читать логи:

```bash
# Все события GenAI
docker compose logs api | grep gen_ai

# Поток логов в реальном времени
docker compose logs -f api
```

В PowerShell вместо `grep` используйте
`docker compose logs api | Select-String gen_ai`.

Атрибуты `gen_ai.prompt_tokens` и `gen_ai.completion_tokens` позволяют считать
стоимость по модели, а `gen_ai.tenant.id` — разносить расходы по клиентам.
Если провайдер не вернул usage, значения будут `0`.
На удалённом стенде (`E2E_BASE_URL`) эти шаги пропускаются: роль и чистое
состояние должен обеспечить сид.

Адрес стенда переопределяется переменной `E2E_BASE_URL` (по умолчанию
`http://localhost:8080`).

### Отчёты и артефакты

HTML-отчёт открывается командой:

```bash
pnpm exec playwright show-report
```

При падении Playwright сохраняет скриншоты и trace в `test-results/`, отчёт —
в `playwright-report/`. В CI эти каталоги публикуются артефактом
`playwright-artifacts` (job `e2e`, retention 7 дней).

### Что делать при падении

* `#email`/`#password` не найдены — проверьте, что `/` редиректит на `/login`,
  а статика собирается из актуального `apps/web`.
* Поле `#chat-message` остаётся disabled — не поднялся Socket.IO; проверьте
  `docker compose logs web api` и проксирование `/socket.io`.
* В чате `insufficient funds` — у тестового пользователя не пополнился
  баланс; проверьте доступность `POST /api/v1/billing/topup`.
* Пустой магазин — не отвечает `GET /api/v1/registry/skills`; проверьте
  `docker compose logs api` и модуль `RegistryModule`.
* Установка навыка возвращает 403 — тестовый пользователь не `admin`;
  локально это делает `promoteToAdmin()` в `beforeAll`.

## 13. Импорт навыков

Навыки из OpenClaw переносятся ZIP-архивом через Control Plane или API.
Эндпоинт доступен только администратору:

```text
POST /api/v1/admin/skills/import
Content-Type: multipart/form-data
Поле файла: file
```

Ограничения и проверки:

* размер архива — до 5 МБ;
* `SKILL.md` ищется в корне архива или во вложенной папке;
* YAML frontmatter валидируется схемой `SkillManifestSchema`;
* skill-vetter блокирует опасные команды (`rm -rf`, `eval`, `curl | sh`);
* при успехе навык сохраняется или обновляется в `InstalledSkill`.

Пример запроса:

```bash
curl -X POST http://localhost:3001/api/v1/admin/skills/import \
  -H "Authorization: Bearer <JWT_АДМИНА>" \
  -F "file=@my-skill.zip"
```

В интерфейсе откройте **Пульт управления → Навыки → Импорт из OpenClaw**,
выберите ZIP-архив и нажмите «Импортировать». Успех подтверждается
сообщением «Навык успешно импортирован», ошибки валидации и skill-vetter
показываются в модалке.

## 14. Тестирование оплаты (ЮKassa)

ЮKassa присылает HTTP-уведомления только на публичный HTTPS-адрес. Для
локального стенда поднимите временный туннель к API на порту `3001`.

### Временный туннель

Через `cloudflared`:

```bash
cloudflared tunnel --url http://localhost:3001
```

Или через `ngrok`:

```bash
ngrok http 3001
```

Скопируйте выданный адрес, например
`https://random-name.trycloudflare.com`. Он живёт только пока запущен
туннель; после перезапуска URL изменится.

### Настройка в личном кабинете ЮKassa

1. Откройте **Личный кабинет → Интеграция → HTTP-уведомления**.
2. Укажите адрес вебхука:

   ```text
   https://random-name.trycloudflare.com/api/v1/billing/webhook
   ```

3. Включите событие `payment.succeeded`. Остальные события API принимает,
   логирует и игнорирует, поэтому `payment.canceled` можно не подключать.
4. Сохраните настройки. Публичный URL должен быть HTTPS и без завершающего
   слэша.

### Переменные окружения

В `.env` должны быть заполнены:

```text
YOOKASSA_SHOP_ID=<shopId>
YOOKASSA_SECRET_KEY=<секретный ключ>
YOOKASSA_RETURN_URL=http://localhost:8080/app/chat?payment=success
```

Сервис `api` получает эти переменные из `env_file: .env` и явно объявленного
блока `environment` в `docker-compose.yml`. После изменения `.env`
перезапустите API:

```bash
docker compose up -d api
```

### Проверка вебхука

1. Откройте логи API:

   ```bash
   docker compose logs -f api
   ```

2. Нажмите «Пополнить» в интерфейсе и оплатите тестовой картой ЮKassa.
3. После возврата проверьте в логах запись `ЮKassa webhook: зачислено ...`
   и обновлённый баланс в кошельке.

Если вебхук не приходит, проверьте, что туннель запущен, URL в кабинете
указывает на `/api/v1/billing/webhook`, а API доступен по `/api/v1/health`.
Не коммитьте реальные ключи ЮKassa и выключайте туннель после тестирования.

## 15. Подключение MCP-серверов

Для Ozon и Wildberries используются Python MCP-серверы с транспортом SSE:

| Сервис | Пакет | Версия | Порт |
| --- | --- | --- | --- |
| `ozon-mcp` | `ozon-mcp-server` | 2.5.2 | 5001 |
| `wb-mcp` | `wb-mcp-server` | 2.6.1 | 5002 |

Оба сервиса описаны в `docker-compose.mcp.yml` и собираются из
`infra/mcp/*.Dockerfile`. API обращается к ним по внутренней сети через
`OZON_MCP_URL` и `WB_MCP_URL`, а ключи передаются только контейнерам MCP.

### Получение ключей

**Ozon** (seller.ozon.ru):

1. Настройки → API-ключи: создайте Client ID и Api-Key для Seller API.
2. Для рекламы (Performance API) создайте отдельные Client ID и
   Client Secret.
3. Заполните в `.env`:

   ```text
   OZON_CLIENT_ID=<client-id>
   OZON_API_KEY=<api-key>
   OZON_PERF_CLIENT_ID=<performance-client-id>
   OZON_PERF_CLIENT_SECRET=<performance-client-secret>
   ```

**Wildberries** (seller.wildberries.ru):

1. Настройки → Доступ к API → Создать токен. Отметьте категории, которые
   нужны навыку (контент, цены, заказы, финансы и т.д.).
2. Заполните в `.env`:

   ```text
   WB_API_TOKEN=<токен>
   ```

3. Токен действует 180 дней; срок можно проверить на странице
   `/diagnostics` WB MCP-сервера.

Для защиты `/sse` задайте общий токен:

```text
MCP_AUTH_TOKEN=<случайная строка>
```

Пустое значение отключает авторизацию — допустимо только во внутренней
compose-сети.

### Запуск MCP-серверов

```bash
docker compose -f docker-compose.yml -f docker-compose.mcp.yml up -d --build
```

Проверка:

```bash
curl http://localhost:5001/api/health
curl http://localhost:5002/api/health
```

Веб-панели MCP-серверов: <http://localhost:5001/shops> и
<http://localhost:5002/shops>. Через них можно добавить магазин и проверить
ключи кнопкой «Проверить».

### Вызов из агента

Инструменты `ozon_mcp_call` и `wb_mcp_call` передают `action` как точное имя
MCP-инструмента из `tools/list`:

```json
{
  "action": "ozon_get_prices",
  "params": { "shop_id": "default" }
}
```

Примеры имён: `ozon_get_prices`, `ozon_orders_fbs`, `ozon_reviews_list`,
`wb_cards_list`, `wb_finance_report`, `wb_advert_list`. Полный список
возвращает `tools/list` соответствующего сервера.

Если ключи не заданы, инструмент вернёт `Ozon API keys not configured` или
`WB API token not configured` и не будет обращаться к MCP-серверу.

### Безопасность

* Не публикуйте порты `5001`/`5002` в интернет: веб-панели MCP не защищены
  `MCP_AUTH_TOKEN`.
* Для удалённого доступа используйте VPN или reverse proxy с TLS.
* Ключи маркетплейсов хранятся в зашифрованном виде в volume
  `ozon_mcp_data`/`wb_mcp_data`; не копируйте только `shops.json` без
  `.encryption_key`.
* Фоновые проверки MCP-серверов отключены (`HEALTH_CHECK_INTERVAL_MIN=0`),
  чтобы не расходовать лимиты API; включайте их осознанно.
