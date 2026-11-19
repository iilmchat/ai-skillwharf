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
- `VITE_LEAD_WEBHOOK_URL` — URL вебхука заявок Design Partner с лендинга.
  Если не задан, форма собирает `mailto:` на `VITE_CONTACT_EMAIL` и текст
  для копирования в Telegram (см. раздел «Лендинг»).

## Проверки

```bash
pnpm --filter web lint
pnpm --filter web build
```

## Лендинг: превью AI-Офиса и заявка Design Partner

Статический лендинг собирается отдельной командой:

```bash
VITE_APP_URL=https://app.skillwharf.ru \
VITE_CONTACT_EMAIL=pilot@skillwharf.ru \
pnpm --filter web build:landing
```

Готовый каталог `dist-landing` (вход — `index.html`) можно выложить в корень
`skillwharf.ru`: приложение на лендинг не влияет. Интерактивные блоки:

- **Превью AI-Офиса для 12 треков A–L** (`src/components/OfficeSimulator.tsx`,
  данные — `src/lib/office-simulator.ts`). Клиентская state machine без
  запросов к API: при выборе трека показываются 3–5 агентов и шаги сценария,
  кнопка «Запустить демо-сценарий» переводит агентов в статус «Работает»,
  сценарий останавливается на шаге HITL и продолжается после «Одобрить»;
  в конце показывается итоговый результат. Таймеры очищаются при смене трека
  и размонтировании, поэтому блок безопасен на статическом хостинге.
- **Форма «Запросить инвайт на пилот»**
  (`src/components/DesignPartnerSection.tsx`, схема —
  `src/lib/design-partner.ts`). Поля: «Имя / Компания», контакт
  (Telegram `@username`, телефон или email), отрасль (12 треков) и
  необязательный комментарий. Валидация — Zod.

`VITE_LEAD_WEBHOOK_URL` задаёт вебхук заявок: форма делает `POST` с JSON

```json
{
  "name": "Иван, ООО «Пример»",
  "contact": "@ivan_partner",
  "track": "wholesale",
  "comment": "Нужен пилот",
  "source": "landing",
  "language": "ru",
  "submittedAt": "2026-11-18T10:00:00.000Z"
}
```

Вебхук должен принимать POST, отвечать 2xx и разрешать CORS с домена
лендинга для `Content-Type: application/json`. Если переменная не задана
(или вебхук вернул ошибку), заявка не теряется: форма формирует `mailto:`
на `VITE_CONTACT_EMAIL` и кнопку «Скопировать заявку для Telegram»; при
недоступном Clipboard API текст показывается в поле для ручного
копирования. На лендинге персональные данные не сохраняются.

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
- `/app/marketplace` — защищённая витрина публичного маркетплейса;
- `/app/store` — защищённый магазин навыков;
- `/app/finance` — защищённый финансовый дашборд (unit-economics и
  fraud-shield-audit);
- `/app/settings` — защищённые настройки: управление долговременной
  памятью и (при включённом флаге) просмотр записей RAG-памяти.

Старые пути `/chat`, `/skills`, `/store`, `/finance` перенаправляют на
`/app/*`, чтобы сохранённые ссылки продолжали работать.

## Картинки в чате

Ответ ассистента разбирается на текст и изображения (`src/lib/message-images.ts`).
Поддерживаются Markdown `![alt](https://...png)`, «голые» http(s)-URL с
расширением `png/jpg/jpeg/gif/webp/avif`, а также JSON-ответ инструмента
`generate_image` с `imageUrl`/`image_url` (TTAPI может не добавлять
расширение файла). Картинка показывается превью `max-h-80`; клик открывает её
в новой вкладке в полном размере (`target="_blank"`,
`rel="noopener noreferrer"`). Ссылки с другими схемами (`javascript:`,
`data:`) не превращаются в `<img>`, а остаются текстом.

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

- «Интеграции» — Telegram, Google Workspace, Ozon, Wildberries, Midjourney,
  Битрикс24 и МойСклад: подключение, статус и отзыв доступа (см. раздел
  «Интеграции» ниже).
- «Долговременная память» — кнопка «Забыть меня» вызывает
  `DELETE /api/v1/chat/memory` и показывает тост об успехе или ошибке.
- «Память» — список записей RAG-памяти. Раздел управляется feature-флагом
  `VITE_RAG_MEMORY_ENABLED`: по умолчанию выключен, хотя read-эндпоинт
  `GET /api/v1/chat/memory` уже реализован (KI-023) — включать его нужно после
  проверки на реальных данных. Пока флаг выключен, панель не рендерится и не
  делает запросов; моки вместо данных не используются.

Когда флаг включён, панель запрашивает `GET /api/v1/chat/memory`, валидирует
ответ Zod по контракту `{ items: [{ id, content, createdAt, kind?, source?,
updatedAt? }], total? }` (схема в `src/lib/rag-memory.ts`) и показывает
состояния загрузки, пустоты, ошибки (401, 404, сеть, невалидный ответ) и
повторной загрузки. Если API нарушает контракт, панель показывает ошибку
валидации, а не подменяет данные. Бейдж `kind`, источник `source` и дату
`updatedAt` панель показывает, только если бэкенд их передал; для старого API
остаётся нейтральный бейдж «Фрагмент памяти» и дата создания (KI-024 закрыта).
Релевантность по-прежнему считается только в момент поиска и не хранится.

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
- **Ozon.** Поля `Client ID` и `API Key` отправляются в
  `POST /api/v1/integrations/ozon`; в `GET /api/v1/integrations` приходит
  `{ status, clientId? }`. Цены Ozon Seller API — v1, товары — v3. Кнопка
  «Отключить» вызывает `DELETE /api/v1/integrations/ozon`.
- **Wildberries.** Поле `API Token` (без Client ID) отправляется в
  `POST /api/v1/integrations/wildberries`
  (`{ apiToken }`); backend ходит на `discounts-prices-api.wildberries.ru`.
  Токен действует 180 дней: если API вернул `tokenExpiresAt` или `expiresAt`,
  UI показывает «Действует до …», иначе предупреждение о 180 днях. Секрет
  после подключения не возвращается.
- **Midjourney.** Поле `TT-API-KEY` отправляется в
  `POST /api/v1/integrations/midjourney` (`{ apiKey }`); подпись в карточке
  явно сообщает, что используется TTAPI, а не официальный API Midjourney.
  Отключение — `DELETE /api/v1/integrations/midjourney`.
- **Битрикс24 (треки K/L).** Поле `Webhook URL` принимает только абсолютный
  `https://`-адрес входящего вебхука портала: проверка формата выполняется
  Zod-схемой `bitrix24WebhookUrlSchema` до запроса, поэтому `http://`,
  `javascript:` и относительные пути отклоняются с локализованной ошибкой.
  Адрес обрезается по краям и уходит в
  `POST /api/v1/integrations/bitrix24` (`{ webhookUrl }`); отключение —
  `DELETE /api/v1/integrations/bitrix24`. Вебхук — секрет: после подключения
  он не возвращается, карточка показывает только «Сохранён на сервере»
  (см. KI-076). Маршруты в API ещё не реализованы (KI-075).
- **МойСклад (треки K/L).** Поле `API Token` проверяется схемой
  `moyskladApiTokenSchema` (непустая строка разумной длины) и отправляется в
  `POST /api/v1/integrations/moysklad` (`{ apiToken }`); отключение —
  `DELETE /api/v1/integrations/moysklad`. Маршруты в API ещё не реализованы
  (KI-075), поэтому до их появления карточки показывают «Интеграция пока
  недоступна».
- **Ошибки.** Коды `errors.provider_auth_required`,
  `errors.provider_not_configured`, `errors.provider_unavailable`,
  `errors.provider_rate_limited`, а также `errors.invalid_telegram_token` и
  `errors.google_oauth_unavailable` переводятся через i18n; для неизвестных
  ответов показывается локализованная категория по HTTP-статусу (сеть, 401,
  403, 404, 5xx). Если endpoint ещё не реализован и backend отвечает `404`,
  UI показывает «Интеграция пока недоступна» и не падает; сырые сообщения
  провайдера в интерфейс не выводятся.

## Финансы

Страница `/app/finance` — дашборд Track J. UI использует поля фактических
ответов `FinanceToolsService` (`unit-economics`, `profit-leak-detector`,
`fraud-shield-audit`) и валидирует их Zod (`src/lib/finance.ts`). Ожидаемый
агрегирующий endpoint — `GET /api/v1/finance/overview`:

```json
{
  "currency": "RUB",
  "period": { "from": "2026-11-01", "to": "2026-11-30" },
  "unitEconomics": [
    {
      "tool": "unit-economics",
      "marketplace": "ozon",
      "sku": "SKU-1",
      "period": { "from": "2026-11-01", "to": "2026-11-30" },
      "dataAvailable": true,
      "revenue": 120000,
      "margin": 30000,
      "marginPercent": 25
    }
  ],
  "profitLeaks": [
    {
      "tool": "profit-leak-detector",
      "marketplace": "ozon",
      "dataAvailable": true,
      "findings": [
        { "code": "penalty", "severity": "high", "amount": 100, "detail": "Штраф Ozon", "source": "ozon_finance_totals" }
      ]
    }
  ],
  "fraudShield": {
    "tool": "fraud-shield-audit",
    "marketplace": "ozon",
    "dataAvailable": true,
    "findings": [],
    "checks": [{ "id": "erid_present", "passed": true }]
  }
}
```

Если агрегирующего endpoint нет, клиент делает fallback на
`GET /api/v1/finance/unit-economics`, `/api/v1/finance/profit-leaks` и
`/api/v1/finance/fraud-shield`. Дашборд показывает выручку, прибыль (`margin`
в рублях), маржу (`marginPercent` или отношение margin/revenue), таблицу SKU
и алерты `profit-leak-detector`; статус `fraud-shield-audit` выводится из
`dataAvailable`/`findings`/`checks`: «Доказательный пакет полный», «Есть
риски» или «Статус не определён». Ошибка `errors.provider_unavailable`
показывается локализованным сообщением, сырые ответы провайдеров не
выводятся.

## Навыки

Страница `/app/skills` использует TanStack Query (`GET /api/v1/skills`, ключ
`['skills']`) и показывает карточки с названием, версией, автором,
описанием и ценой Pay-per-Call. Переключатель включения вызывает
`PATCH /api/v1/skills/:id/toggle` с `{ isEnabled }`, оптимистично обновляет
кэш и инвалидирует его после ответа.

`PATCH /toggle` на бэкенде защищён ролью `admin`: Switch виден только
администратору, остальные пользователи видят статус, цену и подсказку о
правах. Роль берётся из `auth.store`.

## Маркетплейс

Страница `/app/marketplace` (WEB-27.3) показывает публичный каталог навыков.
Список запрашивается через `GET /api/v1/marketplace/skills`, установка — через
`POST /api/v1/marketplace/skills/:slug/install`. Оба ответа валидируются Zod
(`src/lib/marketplace.ts`); `price` из Decimal-строки API приводится к числу.

Витрина поддерживает поиск по названию и описанию с debounce 300 мс, чипсы
всех 12 треков A–L, фильтр по модели оплаты и чекбокс «Только проверенные
(Ed25519)». В карточке показываются бейдж «Проверено Ed25519», теги треков, цена
(«Бесплатно», «15 ₽ / вызов», «100 ₽ / результат»), счётчик установок и кнопка
«Установить», которая после успеха меняется на «Установлено» и показывает
toast. Клик по карточке открывает окно с описанием, разрешениями и статусом
подписи. Если API ещё не выкачен (404/501), страница показывает
локализованное сообщение о недоступности раздела вместо падения.

Бэкенд пока не возвращает поля `permissions`, `signature` и `installed`: окно
пишет «Разрешения не указаны» и определяет статус подписи по `verified`, а
флаг установки хранится в кэше TanStack Query (см. KI-086 в KNOWN_ISSUES).

## Control Plane: A/B-тестирование промптов

Вкладка «Промпты» на `/admin` (WEB-28.1) в drawer'е версий шаблона содержит
блок «A/B-тестирование версий». Форма выбирает две версии, название и долю
трафика B (ползунок 10–90%), затем вызывает
`POST /api/v1/prompts/:id/experiments`. Список экспериментов читается через
`GET /api/v1/prompts/:id/experiments`, остановка — через
`POST /api/v1/prompts/experiments/:expId/stop` с необязательным
`promoteVersionId`. Все ответы валидируются Zod (`src/lib/admin.ts`); схема
принимает несколько вариантов формы ответа API и нормализует их к одному типу.

Карточка эксперимента показывает статус, распределение трафика и таблицу
сравнения вариантов (число вызовов, средняя задержка, средняя стоимость ₽),
кнопки «Остановить» и «Сделать вариант B активным». Если API экспериментов
ещё не выкачен (404/501), блок показывает локализованное сообщение, а не
падает. В интерфейсе нет пользовательского feedback как метрики: бэкенд его
пока не отдаёт. Если API откажет в промоушене версии B (`errors.eval_gate_failed`
в machine-readable поле `code`), кнопка покажет локализованное сообщение о том,
что для версии нет пройденного Eval.

## Control Plane: LLM Evals

В том же drawer'е версий рядом с A/B-блоком расположена панель «Автооценка
качества (LLM Evals)» (WEB-29.5). Она выбирает версию промпта и опциональный
трек A–L и вызывает `POST /api/v1/prompts/:id/evals/run`; история прогонов
читается через `GET /api/v1/prompts/:id/evals`. Ответы валидируются Zod
(`src/lib/admin.ts`): схема прогона включает статус `running|passed|failed`,
`passRate` (доля 0..1 API нормализуется в проценты), `avgScore` (в UI делится
на 100) и необязательные результаты кейсов с `reasoning` судьи. Вердикт API
`verdict: { passed, score, reasoning }` приводится к плоской форме кейса.
В карточке прогона показываются статус, доля пройденных кейсов, средний балл
и раскрывающаяся детализация, где провальные кейсы с пояснением судьи
выделены.

Если API Evals ещё не выкачен (404/501), панель показывает понятное
локализованное сообщение вместо падения.

Все страницы (`LoginPage`, `ChatPage`, `SkillsPage`, `MarketplacePage`,
`FinancePage`) загружаются лениво через `React.lazy` + `Suspense`, поэтому
основной чанк не превышает 500 КБ.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
