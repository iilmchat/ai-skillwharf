# apps/web

Фронтенд SkillWharf: React 19, Vite, TypeScript (strict), Tailwind CSS v4,
Zustand, TanStack Query, React Router и Socket.IO.

## Запуск

```bash
pnpm --filter web dev
```

Dev-сервер поднимается на <http://localhost:5173> и проксирует `/api` и
`/socket.io` на API Gateway <http://localhost:3001>: у REST API не включён
CORS, а WebSocket ходит на тот же origin (`window.location.origin`,
path `/socket.io`). В production этот же путь проксирует reverse proxy
(Caddy/Nginx).

Переменные окружения:

- `VITE_API_URL` — базовый URL REST API (по умолчанию `/api/v1`).
- `VITE_RAG_MEMORY_ENABLED` — включает раздел «Память» на странице
  настроек (по умолчанию выключен: read-API памяти ещё не реализован,
  см. `docs/KNOWN_ISSUES.md`, KI-023).

## Проверки

```bash
pnpm --filter web lint
pnpm --filter web build
```

## Брендбук и темы

Цветовые токены Material 3 (Primary `#6B38D4` в светлой теме и `#8B5CF6` в
тёмной, Tertiary `#0EA5E9`, Surface `#FFFFFF`/`#0F172A`) и шрифты
Inter/Manrope заданы в `src/index.css`. Светлая и тёмная темы переключаются
атрибутом `data-theme` на `<html>`; выбор хранится в Zustand (`persist`) и
применяется до первого рендера скриптом в `index.html`.

## Локализация

Интерфейс переводится через `react-i18next`; словари лежат в
`src/locales/ru.json` и `src/locales/en.json`, инициализация — в
`src/i18n.ts`. Язык по умолчанию — русский, выбор пользователя сохраняется
в `localStorage` под ключом `skillwharf-language`. Переключатель RU/EN есть
на экране входа, в сайдбаре чата и в мобильной шапке.

## Баланс и пополнение

Баланс загружается через TanStack Query (`GET /api/v1/billing/balance`,
ключ `['balance']`) и показывается в сайдбаре и мобильной полосе чата.
Кнопка «Пополнить» открывает нативный `<dialog>` с пресетами 100/500/1000 ₽
и произвольной суммой. `POST /api/v1/billing/topup` получает `userId`
текущего пользователя, `amount` и сгенерированный `idempotencyKey`; после
успеха кэши баланса и истории инвалидируются.

Кнопка «История» открывает историю операций
(`GET /api/v1/billing/ledger`, ключ `['ledger']`): дата, описание, сумма
(зелёная для credit, красная для debit) и остаток после операции. API отдаёт
страницы keyset-пагинации (`{ items, total, nextCursor }`), поэтому модалка
работает через `useInfiniteQuery`: кнопка «Загрузить ещё» подгружает
следующую страницу по opaque-курсору, а уже показанные записи остаются на
месте, если следующая страница не загрузилась. Каждый ответ валидируется
Zod (`src/lib/ledger.ts`).

На текущем бэкенде эндпоинт доступен ролям `user` и `admin`: обычный
пользователь пополняет только свой кошелёк, администратор может указать
`userId` другого пользователя.

## Маршруты и чат

- `/` и `/welcome` — публичный лендинг;
- `/office` и `/app/office` — AI-Офис (демо);
- `/login` — вход по email и паролю (JWT access-токен в Zustand);
- `/app/chat` — защищённый маршрут: создаёт диалог через
  `POST /api/v1/chat/conversations`, подключает Socket.IO с токеном в
  `handshake.auth` и отправляет сообщения событием `send_message`;
- `/app/skills` — защищённый каталог навыков;
- `/app/store` — защищённый магазин навыков;
- `/app/settings` — защищённые настройки: управление долговременной
  памятью и (при включённом флаге) просмотр записей RAG-памяти.

Старые пути `/chat`, `/skills`, `/store` перенаправляют на `/app/*`, чтобы
сохранённые ссылки продолжали работать.

## AI-Офис и ожидания подтверждения

AI-Офис (`/office`, `/app/office`) показывает события агента из WebSocket и
список диалогов, ждущих `approve_action`, из `GET /api/v1/chat/pending`
(ключ кэша `['chat', 'pending']`, запрос только при наличии сессии). Ответ
валидируется Zod (`src/lib/pending-approvals.ts`). Если API прислал
`expiresAt` (TTL ожидания), рядом с ожиданием показывается таймер
«Осталось 23 ч» / «Осталось 15 мин»; после истечения — «Срок ожидания истёк».
Старый API без `expiresAt` поддерживается: таймер просто не рендерится.

Для авторизованного пользователя офис также получает состояние интеграций
(`useIntegrations`, ключ `['integrations', userId]`). Если Telegram или
Google Workspace активен, в карточках агентов и в боковой панели появляются
иконки соответствующих каналов с подсказкой; при недоступном API интеграций
иконки не показываются.

## Настройки, интеграции и память

Страница `/app/settings` содержит три независимых блока:

- «Интеграции» — Telegram и Google Workspace: подключение, статус и отзыв
  доступа (см. раздел «Интеграции» ниже).
- «Долговременная память» — кнопка «Забыть меня» вызывает
  `DELETE /api/v1/chat/memory` и показывает тост об успехе или ошибке.
- «Память» — список записей RAG-памяти. Раздел управляется feature-флагом
  `VITE_RAG_MEMORY_ENABLED`: по умолчанию выключен, хотя read-эндпоинт
  `GET /api/v1/chat/memory` уже реализован (KI-023) — включать его нужно после
  проверки на реальных данных. Пока флаг выключен, панель не рендерится и не
  делает запросов; моки вместо данных не используются.

Когда флаг включён, панель запрашивает `GET /api/v1/chat/memory`, валидирует
ответ Zod по контракту Sprint 14 `{ items: [{ id, content, createdAt }],
total? }` (схема в `src/lib/rag-memory.ts`) и показывает состояния загрузки,
пустоты, ошибки (401, 404, сеть, невалидный ответ) и повторной загрузки.
Если API нарушает контракт, панель показывает ошибку валидации, а не
подменяет данные. В списке отображаются только реальные поля: краткое
содержание, тип «фрагмент памяти» и дата создания. Тип, источник,
`updatedAt` и релевантность модель `MemoryChunk` пока не хранит (KI-024).

Для Docker-сборки флаг передаётся build-arg'ом:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg VITE_RAG_MEMORY_ENABLED=true -t skillwharf-web .
```

Через Compose переменная пробрасывается в build-args сервиса `web`
(`docker-compose.yml` и `docker-compose.staging.yml`), поэтому включение —
`VITE_RAG_MEMORY_ENABLED=true docker compose build web` (или строка в `.env`);
значение по умолчанию — `false`, после изменения нужна пересборка web.

## Интеграции

Раздел «Интеграции» на странице настроек управляет внешними каналами
пользователя. Состояние запрашивается через `GET /api/v1/integrations` и
валидируется Zod (`src/lib/integrations.ts`):

```json
{
  "telegram": {
    "status": "active",
    "botName": "Wharf Bot",
    "botUsername": "wharf_bot"
  },
  "google": {
    "status": "active",
    "email": "owner@example.com"
  }
}
```

`status` принимает `active`, `disconnected` или `error`; необязательное поле
`error` содержит ключ `errors.*` или текст для объяснения ошибки.

- **Telegram.** Поле `Bot Token` проверяет формат, затем
  `POST /api/v1/integrations/telegram` с `{ botToken }`; бэкенд вызывает
  Telegram `getMe`. После успеха показываются имя бота (или `@username`) и
  статус «Подключено». Кнопка «Отключить» вызывает
  `DELETE /api/v1/integrations/telegram`. Токен хранится на сервере и после
  подключения в UI не возвращается.
- **Google Workspace.** Кнопка «Войти через Google» получает
  `GET /api/v1/integrations/google/authorization-url` (`{ url }` или
  `{ authorizationUrl }`), проверяет, что это абсолютный `https`-URL, и
  выполняет редирект. После возврата с OAuth статус и email подтягиваются из
  `GET /api/v1/integrations`; при заданном `GOOGLE_OAUTH_SUCCESS_REDIRECT`
  backend возвращает браузер в настройки, иначе callback отдаёт JSON для
  диагностики — откройте `/app/settings` вручную. Кнопка «Отозвать доступ»
  вызывает `DELETE /api/v1/integrations/google`.
- **Ошибки.** Коды `errors.provider_auth_required`,
  `errors.provider_not_configured`, `errors.provider_unavailable`,
  `errors.provider_rate_limited`, а также `errors.invalid_telegram_token` и
  `errors.google_oauth_unavailable` переводятся через i18n; для неизвестных
  ответов показывается локализованная категория по HTTP-статусу (сеть, 401,
  403, 404, 5xx) или текст сервера. Если API интеграций ещё не развёрнут,
  карточка показывает ошибку `notFound`, а не вымышленный статус.

## Навыки

Страница `/app/skills` использует TanStack Query (`GET /api/v1/skills`, ключ
`['skills']`) и показывает карточки с названием, версией, автором,
описанием и ценой Pay-per-Call. Переключатель включения вызывает
`PATCH /api/v1/skills/:id/toggle` с `{ isEnabled }`, оптимистично обновляет
кэш и инвалидирует его после ответа.

`PATCH /toggle` на бэкенде защищён ролью `admin`: Switch виден только
администратору, остальные пользователи видят статус, цену и подсказку о
правах. Роль берётся из `auth.store`.

Все страницы (`LoginPage`, `ChatPage`, `SkillsPage`) загружаются лениво через
`React.lazy` + `Suspense`, поэтому основной чанк не превышает 500 КБ.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
