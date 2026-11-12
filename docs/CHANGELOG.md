# Changelog

Все значимые изменения в проекте документируются в этом файле.

## [Unreleased]

### Добавлено

- Базовая документация: C4-модель, спецификация Skill Manifest, схема биллинга, STRIDE Threat Model, Runbook развертывания.
- Монорепозиторий на базе pnpm workspaces.
- Пакет `packages/shared` со схемами Zod (Skill Manifest, Billing).
- Каркас API на NestJS (`apps/api`).
- Docker-инфраструктура: `Dockerfile` для API и `docker-compose.yml` (API + PostgreSQL).
- Базовая песочница `docker-compose.sandbox.yml` (hardened Docker).
- Prisma ORM: схема БД (`User`, `Session`, `Transaction`), первая миграция и скрипт `db:migrate`.
- Эндпоинт `GET /api/v1/health` с проверкой подключения к PostgreSQL.
- Модуль аутентификации: регистрация/логин (Argon2, JWT access + refresh), `JwtStrategy` и `JwtAuthGuard`.
- Ротация refresh-токенов: `POST /api/v1/auth/refresh` с проверкой сессии и срока действия.
- RBAC: поле `role` у пользователя (по умолчанию `user`), декоратор `@Roles()` и `RolesGuard`.
- Защищённый эндпоинт `GET /api/v1/auth/me` (профиль текущего пользователя).
- Модели `Conversation` и `Message` — история диалогов в БД.
- WebSocket-шлюз `send_message` и чат-сервис (сохранение сообщений, ответ LLM).
- Интеграция LangGraph (`StateGraph`) и LLM-клиент `@langchain/openai` с эхо-заглушкой без ключей.
- Локальный Ollama в `docker-compose` (профиль `with-llm`) и переменные `LLM_*`.
- REST API диалогов: `POST /api/v1/chat/conversations` (создание чата текущего пользователя).
- Аутентификация WebSocket по JWT из `handshake.auth.token` и проверка владельца диалога.
- Валидация `SKILL.md`: парсинг YAML frontmatter и Zod-схема `@skillwharf/shared`, эндпоинт `POST /api/v1/skills/validate` (только `admin`).
- Sandbox: эндпоинт `POST /api/v1/sandbox/execute` (только `admin`) для запуска команд в изолированном Docker-контейнере.
- Биллинг: модели `Wallet` и append-only `LedgerEntry`, `GET /api/v1/billing/balance` и `POST /api/v1/billing/topup` (только `admin`) с атомарным начислением через `prisma.$transaction`.
- Точность денег `DECIMAL(18,2)` для `Wallet.balance` / `LedgerEntry.amount` и триггеры PostgreSQL, запрещающие `UPDATE`/`DELETE` в Ledger.
- Идемпотентность биллинга: `LedgerEntry.idempotencyKey @unique`, повторные запросы возвращают текущий баланс без дублей.
- Paywall: `BillingService.chargeForSkill` и `POST /api/v1/billing/charge` (только `admin`, для тестов); списание атомарное через условный `updateMany`, `LedgerEntry.balanceAfter` фиксирует баланс после операции.
- BAL: единый интерфейс `IBillingProvider` из `@skillwharf/shared` (`authorize`/`capture`/`cancel`) и mock-провайдер ЮKassa.
- Каталог навыков: модель `InstalledSkill`, `POST /api/v1/skills/install` (только `admin`) и `GET /api/v1/skills` для авторизованных.
- Сборка `packages/shared` в ESM-`dist` (пакет импортируется в API рантайме).
- Roadmap проекта и структура спринтов (`docs/development/ROADMAP.md`).

### Изменено

- CI настроен на проверку сборки, тестов, Markdown-линтера и тестов песочницы.
- Docker-образ API переведён на `pnpm deploy --prod` (560 МБ вместо 904 МБ), Prisma CLI для `db:migrate` ставится глобально.

## [0.1.0] - 2026-11-12

- Инициализация репозитория.
