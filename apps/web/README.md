# apps/web

Фронтенд SkillWharf: React 19, Vite, TypeScript (strict), Tailwind CSS v4,
Zustand, TanStack Query и React Router.

## Запуск

```bash
pnpm --filter web dev
```

Dev-сервер поднимается на <http://localhost:5173> и проксирует `/api` на API
Gateway <http://localhost:3001>: у REST API не включён CORS. Прямые запросы
включаются переменной окружения `VITE_API_URL` (например,
`http://localhost:3001/api/v1`).

## Проверки

```bash
pnpm --filter web lint
pnpm --filter web build
```

## Маршруты

- `/login` — вход по email и паролю (JWT access-токен в Zustand);
- `/chat` — защищённый маршрут с каркасом чата.

Access-токен хранится только в памяти вкладки: после перезагрузки страницы
нужно войти заново, пока не реализована ротация refresh-токена.
