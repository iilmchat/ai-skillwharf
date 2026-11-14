# OpenAPI и Swagger UI

API SkillWharf документируется через `@nestjs/swagger`. Документ строится из
декораторов контроллеров и доступен в двух видах: интерактивный Swagger UI и
JSON-файл для Postman/Insomnia/codegen.

## Что открывается

| Ресурс | URL |
| --- | --- |
| Swagger UI | <http://localhost:3001/api/docs> |
| OpenAPI JSON | <http://localhost:3001/api/docs-json> |
| OpenAPI YAML | <http://localhost:3001/api/docs-yaml> |

`/api/docs` — отдельный путь, а не часть `/api/v1`: документация не должна
попадать под префикс версии API. Сами эндпоинты внутри документа указаны
вместе с префиксом, например `POST /api/v1/auth/login`.

### Почему порт 3001

В `docker-compose.yml` API слушает 3000 внутри контейнера, а на хост
проброшен как 3001:

```yaml
ports:
  - "3001:3000"
```

Если API запущен не в compose, а напрямую (`pnpm --filter api start:dev`),
используйте порт из переменной `PORT` (по умолчанию 3000):

```text
http://localhost:3000/api/docs
```

## Локальный запуск

```bash
# Вариант 1: весь стек в compose (API, PostgreSQL, Redis, web)
docker compose up -d api

# Вариант 2: API на хосте (нужны PostgreSQL и переменные окружения)
pnpm --filter api start:dev
```

Проверьте, что API отвечает:

```bash
curl -s http://localhost:3001/api/v1/health/live
```

Затем откройте <http://localhost:3001/api/docs>. Список тегов в UI:
`Auth`, `Chat`, `Billing`, `Integrations`, `Finance` — это основные
контроллеры; служебные (`Health`, `Metrics`, внутренние маршруты агента)
могут отображаться без отдельного тега.

## Авторизация в Swagger UI

1. Выполните `POST /api/v1/auth/login` (или `POST /api/v1/auth/register`).
2. Скопируйте `accessToken` из ответа.
3. Нажмите **Authorize** вверху Swagger UI.
4. Вставьте токен в поле **bearer** (без префикса `Bearer`) и подтвердите.

После этого защищённые методы отправляют заголовок
`Authorization: Bearer <accessToken>`. Опция `persistAuthorization`
сохраняет токен между перезагрузками страницы, но не между вкладками.

Срок жизни access-токена — 15 минут. Когда он истечёт, возьмите новый через
`POST /api/v1/auth/refresh` с сохранённым `refreshToken`.

## Экспорт `swagger.json`

```bash
pnpm run openapi:export
```

Скрипт:

1. собирает API (`pnpm --filter api build`), чтобы генератор работал с
   актуальными контроллерами;
2. пишет документ в `docs/openapi/swagger.json`.

Экспорт не требует подключения к PostgreSQL или Redis: скрипт запускает
Nest-приложение с отключёнными `DATABASE_URL`/`REDIS_URL`, а `JWT_SECRET`
подставляется заглушкой — токены при генерации не выпускаются. Swagger
читает только метаданные декораторов.

Необязательный аргумент задаёт другой путь (относительно корня
монорепозитория):

```bash
pnpm run openapi:export -- ./tmp/swagger.json
```

Альтернатива без сборки — скачать документ у запущенного API:

```bash
curl -s http://localhost:3001/api/docs-json -o swagger.json
```

### Импорт в Postman

1. Postman → **Import** → **File**.
2. Выберите `docs/openapi/swagger.json`.
3. В окружении задайте `baseUrl = http://localhost:3001` — пути в документе
   уже содержат префикс `/api/v1`.
4. Для защищённых запросов добавьте заголовок
   `Authorization: Bearer <accessToken>`.

Если API уже запущен, можно импортировать по URL:
`http://localhost:3001/api/docs-json`.

## curl: аутентификация

Все примеры используют `http://localhost:3001/api/v1`. Если API запущен на
другом порту, замените базу.

### Регистрация

```bash
curl -s -X POST http://localhost:3001/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"correct-horse-battery"}'
```

Ожидаемый ответ (`201 Created`):

```json
{
  "id": "clx0000000000000000000000",
  "email": "user@example.com"
}
```

### Вход и получение access-токена

```bash
curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"correct-horse-battery"}'
```

Ответ (`200 OK`):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

Сохраните токен в переменную (нужен `jq`):

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"correct-horse-battery"}' \
  | jq -r '.accessToken')
```

### Защищённый запрос

```bash
curl -s http://localhost:3001/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

Без токена или с истёкшим токеном API вернёт `401 Unauthorized`.

## curl: чат

### Создать диалог

```bash
curl -s -X POST http://localhost:3001/api/v1/chat/conversations \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Проверка Swagger"}'
```

Ответ (`201 Created`):

```json
{ "id": "cm00000000000000000000000" }
```

### Отправить сообщение

REST-эндпоинта отправки сообщений в API нет: сообщения идут через Socket.IO
событием `send_message`. Поэтому `curl` здесь не подходит — используйте
клиент Socket.IO. Пример для Node.js (запускать из `apps/web`, где установлен
`socket.io-client`):

```js
import { io } from 'socket.io-client';

const token = process.env.TOKEN;
const conversationId = process.env.CONVERSATION_ID;

const socket = io('http://localhost:3001', {
  path: '/socket.io',
  auth: { token },
});

socket.on('connect', () => {
  socket.emit('send_message', {
    conversationId,
    content: 'Привет! Что умеет SkillWharf?',
  });
});

socket.on('stream_delta', ({ text }) => process.stdout.write(text));
socket.on('stream_end', () => socket.close());
socket.on('connect_error', (error) => {
  console.error(error.message);
  socket.close();
});
```

Событие `send_message` возвращает `ChatReply`; поток текста приходит
событиями `stream_delta`, завершение — `stream_end`. Список диалогов,
ожидающих подтверждения действия, доступен по
`GET /api/v1/chat/pending`.

## Что документировано

| Тег | Контроллер | Защита |
| --- | --- | --- |
| `Auth` | `AuthController` | `POST /auth/login`, `/register`, `/refresh` публичные; `/me` — Bearer |
| `Chat` | `ChatController` | Bearer на всех методах |
| `Billing` | `BillingController` | Bearer, кроме публичного `POST /billing/webhook` |
| `Integrations` | `IntegrationsController` | Bearer на всех методах |
| `Finance` | `FinanceController` | Bearer на всех методах |

Во всех защищённых операциях в Swagger UI отображается замок, а запросы
содержат `Authorization: Bearer <JWT>`.

## Ограничения

- **WebSocket не входит в OpenAPI.** `send_message` и `approve_action`
  описаны только в этом README и в коде `chat.gateway.ts`.
- **Zod-схемы запросов не попадают в Swagger полностью.** Например,
  `GET /billing/ledger` и фильтры `/finance/*` валидируются Zod вручную,
  поэтому в UI у них могут быть не все query-параметры. Это осознанно:
  источник правды — Zod-схема, а не декораторы.
- **Внутренние маршруты** `/internal/agent/*` защищены `InternalTokenGuard`
  и не предназначены для ручных вызовов из Swagger UI.
