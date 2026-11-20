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
- `/app/team` — защищённая страница «Команда и доступ»;
- `/app/store` — защищённый магазин навыков;
- `/app/finance` — защищённый финансовый дашборд (unit-economics и
  fraud-shield-audit);
- `/app/settings` — защищённые настройки: управление долговременной
  памятью и (при включённом флаге) просмотр записей RAG-памяти.

Старые пути `/chat`, `/skills`, `/store`, `/finance` перенаправляют на
`/app/*`, чтобы сохранённые ссылки продолжали работать.

## Воркспейсы и команда

Компактный `WorkspaceSwitcher` расположен в сайдбаре чата и в шапке страницы
«Команда»: показывает название активного воркспейса и роль пользователя,
позволяет выбрать другой воркспейс или создать новый. Выбор сохраняется в
localStorage (`skillwharf-workspace`), а HTTP-клиент (`src/lib/api.ts`)
автоматически добавляет заголовок `X-Workspace-Id` ко всем запросам. При
смене воркспейса инвалидируются кэши чатов, навыков, маркетплейса,
интеграций и реестра навыков.

Страница `/app/team` читает `GET /api/v1/workspaces` и
`GET /api/v1/workspaces/:id/members` через Zod-клиент `src/lib/workspaces.ts`,
показывает таблицу участников с ролями `owner/admin/operator/viewer` и
лимитом автоодобрения HITL. Пользователи с ролью `owner` или `admin` могут
добавлять участника (`POST .../members`) и менять роль/лимит
(`PATCH .../members/:memberId`). Ошибки `errors.insufficient_workspace_role`
и `errors.hitl_limit_exceeded` показываются локализованными уведомлениями.
Лимит принимается числом, Decimal-строкой или `null` (без лимита).

## Конструктор агентов (No-Code Builder)

Защищённая страница `/app/builder` (Sprint 35, BUILDER-35.1/35.3) позволяет
собрать кастомного агента — «стол» AI-Офиса — без кода. Пункт «Конструктор»
добавлен в основную навигацию. Контракт и клиент — `src/lib/agent-builder.ts`,
все ответы валидируются Zod:

- `hitlPolicySchema`: `never` / `high_risk` / `always`;
- `customAgentRoleSchema`: `id`, `workspaceId`, `name`, `roleKey`, `description?`,
  `systemPrompt`, `skillSlugs`, `hitlPolicy`, `dailyBudgetRub` (число,
  Decimal-строка или `null`), `isActive`, `createdAt`;
- `createCustomAgentSchema`: строгая форма; `roleKey` генерируется из названия
  (кириллица транслитерируется, `generateRoleKey`) и проверяется регулярным
  выражением `^[a-z0-9-]{2,40}$` (совпадает с backend). Ограничения полей
  формы (`name` 2–80, `systemPrompt` от 10 символов, slug навыка) тоже
  приведены к контракту API.

Клиент: `fetchWorkspaceAgents(workspaceId)` →
`GET /api/v1/workspaces/:id/agents`, `createWorkspaceAgent` → `POST`,
`updateWorkspaceAgent` → `PATCH .../agents/:agentId`, `deleteWorkspaceAgent` →
`DELETE .../agents/:agentId`. Ключ кэша — `['workspace-agents', workspaceId]`.

Интерфейс двухколоночный: слева форма (название, описание, чекбоксы
установленных навыков, редактор системного промпта с пресетами «Менеджер
продаж» / «Аналитик склада» / «Контролёр документов», радиокнопки HITL и
дневной бюджет), справа — живое превью карточки стола AI-Офиса и список
созданных агентов с переключателем активности и удалением. Пользователи с
ролью `viewer` видят данные, но не могут изменять их. RU/EN-ключи —
`nav.builder` и `builder.*`. Если API ещё не выкачен (404), раздел показывает
локализованное сообщение вместо падения.

## Картинки в чате

Ответ ассистента разбирается на текст и изображения (`src/lib/message-images.ts`).
Поддерживаются Markdown `![alt](https://...png)`, «голые» http(s)-URL с
расширением `png/jpg/jpeg/gif/webp/avif`, а также JSON-ответ инструмента
`generate_image` с `imageUrl`/`image_url` (TTAPI может не добавлять
расширение файла). Картинка показывается превью `max-h-80`; клик открывает её
в новой вкладке в полном размере (`target="_blank"`,
`rel="noopener noreferrer"`). Ссылки с другими схемами (`javascript:`,
`data:`) не превращаются в `<img>`, а остаются текстом.

## Артефакты и инспектор шагов (Sprint 37)

Ответ ассистента может нести в метаданных (`src/lib/message-metadata.ts`)
 необязательные `artifacts` и `executionTrace`; контракты и парсеры лежат в
`src/lib/artifacts.ts` и валидируются Zod. Старые ответы без этих полей
отображаются как прежде.

Если в ответе есть артефакты (`{ id, type: 'document' | 'table' | 'code',
title, language?, content }`), под текстом показываются компактные карточки.
Кнопка «Открыть в Canvas» раскрывает справа панель
(`src/components/chat/ArtifactCanvasDrawer.tsx`): документ рендерится как
ограниченный Markdown, таблица — как HTML-таблица (Markdown или CSV на входе),
код — блоком с подписью языка. В панели можно выделить фрагмент (в просмотре
или в режиме правки), заполнить «Инструкцию для ИИ» (пресеты «Пересчитать
только этот раздел» и «Сделать строже юридически») и отправить
`POST /api/v1/chat/artifacts/refine` через клиент `refineArtifact`. Ответ API
проверяется Zod, после успеха обновлённый текст сохраняется в метаданных
сообщения и остаётся в контексте диалога.

Экспорт выполняется в браузере без тяжёлых зависимостей: `.md`, `.csv` для
таблиц и печатные `.html` / `.doc` (Word-совместимый HTML с реквизитами и
разметкой A4). Перед скачиванием весь текст экранируется, поэтому содержимое
артефакта не может подставить произвольный HTML.

Непустой `executionTrace` показывает над ответом сворачиваемую плашку «Ход
работы агента (N шагов · X.X сек · Y ₽)»
(`src/components/chat/ExecutionTraceAccordion.tsx`). Раскрытие даёт
вертикальный таймлайн: номер шага, название, инструмент, иконку статуса
(`completed` / `failed` / `hitl_paused`), длительность и стоимость. Все подписи
RU/EN — в ключах `chat.artifacts.*` и `chat.execution.*`.

## База знаний, цитаты и голосовой ввод (Sprint 38)

Защищённая страница `/app/knowledge` (`src/pages/KnowledgeHubPage.tsx`)
показывает папки регламентов слева и проиндексированные документы справа:
создание/удаление папок, поиск, загрузка регламента и статус индексации.
Клиент `src/lib/knowledge.ts` валидирует все ответы Zod и инвалидирует кэши
TanStack Query после изменений.

Если ответ ассистента содержит `citations`, под текстом появляются бейджи
`[1] Регламент приёмки` (`src/components/chat/CitationBadges.tsx`). Нажатие
раскрывает карточку с подсвеченным сниппетом, номером страницы и ссылкой в
Knowledge Hub с идентификатором чанка.

В строке ввода чата есть кнопка микрофона (`src/hooks/useVoiceRecorder.ts`):
`getUserMedia` + `MediaRecorder` с индикатором записи и таймером, затем аудио
уходит в `POST /api/v1/chat/transcribe`, а распознанный текст подставляется в
поле ввода. Если браузер не поддерживает запись или доступ к микрофону запрещён,
кнопка блокируется/показывает локализованную подсказку.

Для мобильного режима добавлен `public/manifest.webmanifest` (подключён в
`index.html`): installable PWA-манифест с иконкой и ярлыками чата и базы знаний.
Offline-shell и push-уведомления пока не реализованы. RU/EN-ключи —
`knowledge.*`, `chat.citations.*`, `chat.voice.*` и `nav.knowledge`.

## Telegram-каналы и Mini App (Sprint 39)

В Настройках добавлена секция «Telegram-бот и мессенджеры»
(`src/components/TelegramChannelsSection.tsx`): пошаговая инструкция по
получению токена у `@BotFather`, поле токена через `SecretField`, список
разрешённых Chat ID, список подключённых ботов со статусом, маскированным
токеном, копируемым Webhook URL и кнопкой отключения. Клиент
`src/lib/telegram-channels.ts` валидирует токен и chat_id через Zod и работает
с `/api/v1/workspaces/:workspaceId/channels/telegram`.

Маршрут `/tg-app` (`src/pages/TelegramMiniAppPage.tsx`) — компактный Mini App
для Telegram WebView: инициализирует `Telegram.WebApp`, показывает статус
AI-Офиса и счётчики HITL/передач, крупные кнопки «Одобрить»/«Отклонить» для
ожидающих задач (через тот же socket-протокол `approve_action`, что и чат) и
быстрые ссылки на бота и полную веб-версию. Вне Telegram страница работает как
обычный мобильный экран. RU/EN-ключи — `settings.telegram.*` и `tgApp.*`.

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

Событие `office_event` с типом `agent_handoff` (`fromRole`, `toRole`, `reason`)
валидируется Zod (`src/lib/office-events.ts`) и попадает в компактную ленту
последних передач (`store/office.store.ts`, до 8 записей с привязкой к
`conversationId`). Карточки ролей-участников подсвечиваются: «Передаёт» и
«Принимает»; само событие не меняет статус агента. В чате метаданные ответа
валидируются схемой `assistantMessageMetadataSchema` с необязательным
`cacheHit`: при `true` рядом с ответом показывается бейдж «Из кеша · 0 ₽» /
«Cached · 0 ₽» с пояснением, что ответ найден в семантическом кеше без расхода
токенов. Метаданные читаются из ack и `stream_end`; старый API без них
работает как раньше.

## Настройки, интеграции и память

Страница `/app/settings` содержит четыре независимых блока:

- «Интеграции» — Telegram, Google Workspace, Ozon, Wildberries, Midjourney,
  Битрикс24, МойСклад и 1С:Предприятие: подключение, статус и отзыв доступа
  (см. раздел «Интеграции» ниже).
- «Вебхук-триггеры» — создание/удаление триггеров автозапуска агентов и
  просмотр готового Webhook URL с секретом `X-Trigger-Secret` (см. раздел
  «Вебхук-триггеры» ниже).
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
- **1С:Предприятие (OData, Sprint 32).** Карточка «1С:Предприятие» запрашивает
   OData URL (абсолютный `http://` или `https://`, например
   `https://company.ru`), логин и пароль. Zod-схемы `oneCOdataUrlSchema`,
   `oneCUsernameSchema`, `oneCPasswordSchema` и `oneCCredentialsSchema`
   (`src/lib/integrations.ts`) проверяют форму до запроса; пароль рисуется
   компонентом `SecretField` с маскировкой и хранится только на сервере.
   Подключение — `POST /api/v1/integrations/1c`
   (`{ odataUrl, username, password }`), отключение —
   `DELETE /api/v1/integrations/1c`. Статус из `GET /integrations` содержит
   `onec: { status, odataUrl?, source?, error? }`; если API о нём не знает,
   карточка считается отключённой. Отказ 1С (400/502 `errors.provider_auth_required`)
   показывает локализованное сообщение
   `settings.integrations.oneC.credentialsRejected`.
- **Ошибки.** Коды `errors.provider_auth_required`,
  `errors.provider_not_configured`, `errors.provider_unavailable`,
  `errors.provider_rate_limited`, а также `errors.invalid_telegram_token` и
  `errors.google_oauth_unavailable` переводятся через i18n; для неизвестных
  ответов показывается локализованная категория по HTTP-статусу (сеть, 401,
  403, 404, 5xx). Если endpoint ещё не реализован и backend отвечает `404`,
  UI показывает «Интеграция пока недоступна» и не падает; сырые сообщения
  провайдера в интерфейс не выводятся.

## Вебхук-триггеры (WEB-32.3)

Секция «Вебхук-триггеры (Автозапуск агентов)» расположена на странице
`/app/settings` сразу после интеграций. Формы и ответы API валидируются Zod
(`src/lib/triggers.ts`):

- `createTriggerInputSchema` — название, источник (`bitrix24`, `moysklad`,
  `1c`, `custom`) и шаблон промпта. В шаблоне можно использовать `{{payload}}`
  — он заменяется на тело входящего события.
- `triggerSchema` / `triggerListSchema` — карточка триггера (`id`, `name`,
  `source`, `promptTemplate`, `slug`, `triggerCount`, `status`, `createdAt?`);
  список приходит массивом или обёрткой `{ items }`. Счётчик срабатываний
  (`triggerCount`) нормализуется из числа или строки.
- `createdTriggerSchema` — ответ создания с одноразовым `secret`.

Клиент: `fetchTriggers()` → `GET /api/v1/triggers`, `createTrigger(input)` →
`POST /api/v1/triggers`, `deleteTrigger(id)` → `DELETE /api/v1/triggers/:id`.
Ключ кэша TanStack Query — `['triggers', userId]`.

После создания показывается карточка с готовым URL
`/api/v1/webhooks/triggers/:slug` (функция `getTriggerWebhookUrl`) и секретом
`X-Trigger-Secret`. URL и секрет можно скопировать; секрет маскируется,
переключатель «Показать/Скрыть» и кнопка «Скопировать» работают из общего
интерфейса секций. Секрет выдаётся только при создании и больше не
возвращается API. Список показывает источник, счётчик срабатываний, шаблон
промпта и кнопку удаления; при 404/5xx/сетевой ошибке раздел показывает
локализованное сообщение вместо падения. RU/EN-ключи — `settings.triggers.*`.

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

## Портал разработчиков навыков

Защищённая страница `/app/developer` (Sprint 36, WEB-36.3) доступна по пункту
«Разработчикам» рядом с маркетплейсом. Контракт и клиент —
`src/lib/developer-portal.ts`, все ответы валидируются Zod:

- `auditFindingSchema` (`severity` `critical|warning|info`, `code`, `message`),
  `auditStatusSchema` (`passed|warning|rejected`);
- `developerSkillItemSchema` (`price` числом или Decimal-строкой → число,
  `downloadsCount`, `verified`, `auditFindings?`, `payoutAccountId?`);
- `developerDashboardSchema` (`totalSkills`, `totalDownloads`,
  `totalRevenueRub`, `pendingPayoutRub`, `skills`) — денежные строки
  нормализуются в числа, принимается также обёртка `{ dashboard }`.
  Публикация и обновление счёта возвращают `{ skill }` — клиент разворачивает
  обёртку.

Клиенты: `fetchDeveloperDashboard()` → `GET /api/v1/developer/skills`,
`publishDeveloperSkill({ manifestYaml, payoutAccountId? })` → `POST`,
`updateSkillPayoutAccount(slug, payoutAccountId)` →
`PATCH /api/v1/developer/skills/:slug/payout`. Ключ кэша — `['developer-portal']`.

Страница показывает 4 KPI-карточки автора (навыки, установки, заработано 85%,
ожидает выплаты), форму публикации `SKILL.md` с YAML-шаблоном, Markdown-
инструкцией и опциональным Payout Account ID, а также таблицу опубликованных
навыков с бейджем аудита (тултип с замечаниями) и инлайн-редактированием счёта
выплат. При ответе `400 errors.skill_audit_rejected` ошибка
`DeveloperPortalError` несёт список замечаний — они показываются списком под
формой. RU/EN-ключи — `nav.developer`, `developerPortal.*` и
`errors.skill_audit_rejected`. Если API ещё не выкачен (404/501), страница
показывает локализованное сообщение вместо падения.

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

## Control Plane: финансы и клиринг

Вкладка «Финансы» / `Billing` на `/admin?tab=billing` (WEB-33.3) показывает
состояние финансового клиринга Sprint 33 (KI-087). Контракт и клиент живут в
`src/lib/admin.ts`, все ответы валидируются Zod:

- `treasurySummarySchema`: `treasuryBalanceRub` (число или Decimal-строка),
  `counts` (`pending`/`sent`/`failed_dead`) и `recentOutbox` — массив
  `billingOutboxItemSchema` (`id`, `eventType`, `idempotencyKey?`, `status`,
  `attempts`/`maxAttempts`, `lastError`, `createdAt`, `sentAt`). Схема
  нормализует фактический ответ бэкенда `{ balance: { balance, heldBalance },
  outbox: { pending, sent, failedDead }, recent: [...] }` к этому виду;
  `idempotencyKey` необязателен, потому что backend не включает его в список
  `recent`.
- `reconciliationReportSchema`: `balanced`, `discrepancyRub`, необязательные
  `ledgerNetRub` и `walletsTotalRub` (Decimal-строки приводятся к числам);
  принимаются также имена бэкенда `ledgerRub`/`walletsRub`.
- Клиенты: `fetchTreasurySummary()` (`GET /api/v1/admin/billing/treasury`),
  `fetchBillingReconciliation()` (`GET /api/v1/admin/billing/reconciliation`),
  `retryOutboxItem(id)` (`POST /api/v1/admin/billing/outbox/:id/retry`;
  пустое тело 204 допустимо, подтверждение `{ retried: true, id }` и
  обновлённая запись разбираются Zod).

Вкладка (`src/components/admin/BillingClearingTab.tsx`) содержит три блока:
карточку «Кошелёк платформы» с накопленной комиссией 15% и счётчиками Outbox,
карточку «Сверка Ledger» с зелёным бейджем «Сходится (0 ₽ расхождений)» или
предупреждением о расхождении и кнопкой «Обновить сверку», и таблицу «Очередь
выплат авторам» со статусом, числом попыток, текстом последней ошибки и
кнопкой «Повторить» для записей `failed_dead`. RU/EN-ключи —
`admin.billing.*`, `admin.tabs.billing`, `admin.errors.treasury/reconciliation/retryOutbox`.

Если API клиринга ещё не выкачен (404/501), вкладка показывает локализованное
сообщение «API управления пока недоступен» вместо падения.

Все страницы (`LoginPage`, `ChatPage`, `SkillsPage`, `MarketplacePage`,
`FinancePage`) загружаются лениво через `React.lazy` + `Suspense`, поэтому
основной чанк не превышает 500 КБ.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
