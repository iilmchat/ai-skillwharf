# apps/web

Фронтенд SkillWharf: React 19, Vite, TypeScript (strict), Tailwind CSS v4,
Zustand, TanStack Query, React Router и Socket.IO.

## Запуск

```bash
pnpm --filter web dev
```

Dev-сервер поднимается на <http://localhost:5173> и проксирует `/api` на API
Gateway <http://localhost:3001>: у REST API не включён CORS. Socket.IO
подключается к `http://localhost:3001` напрямую (у gateway включён CORS).

Переменные окружения:

- `VITE_API_URL` — базовый URL REST API (по умолчанию `/api/v1`);
- `VITE_WS_URL` — адрес Socket.IO-сервера (по умолчанию
  `http://localhost:3001`).

## Проверки

```bash
pnpm --filter web lint
pnpm --filter web build
```

## Брендбук и темы

Цветовые токены Material 3 (Primary `#8B5CF6`, Tertiary `#0EA5E9`, Surface
`#FFFFFF`/`#0F172A`) и шрифты Inter/Manrope заданы в `src/index.css`.
Светлая и тёмная темы переключаются атрибутом `data-theme` на `<html>`;
выбор хранится в Zustand (`persist`) и применяется до первого рендера
скриптом в `index.html`.

## Маршруты и чат

- `/login` — вход по email и паролю (JWT access-токен в Zustand);
- `/chat` — защищённый маршрут: создаёт диалог через
  `POST /api/v1/chat/conversations`, подключает Socket.IO с токеном в
  `handshake.auth` и отправляет сообщения событием `send_message`.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
