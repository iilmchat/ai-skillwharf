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
успеха кэш баланса инвалидируется.

На текущем бэкенде эндпоинт доступен ролям `user` и `admin`: обычный
пользователь пополняет только свой кошелёк, администратор может указать
`userId` другого пользователя.

## Маршруты и чат

- `/login` — вход по email и паролю (JWT access-токен в Zustand);
- `/chat` — защищённый маршрут: создаёт диалог через
  `POST /api/v1/chat/conversations`, подключает Socket.IO с токеном в
  `handshake.auth` и отправляет сообщения событием `send_message`;
- `/skills` — защищённый каталог навыков.

## Навыки

Страница `/skills` использует TanStack Query (`GET /api/v1/skills`, ключ
`['skills']`) и показывает карточки с названием, версией, автором,
описанием и ценой Pay-per-Call. Переключатель включения вызывает
`PATCH /api/v1/skills/:id/toggle` с `{ isEnabled }`, оптимистично обновляет
кэш и инвалидирует его после ответа.

`PATCH /toggle` на бэкенде защищён ролью `admin`: обычный пользователь
получит 403 и локализованный тост, а Switch вернётся в исходное состояние.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
