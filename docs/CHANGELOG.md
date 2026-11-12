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
- Roadmap проекта и структура спринтов (`docs/development/ROADMAP.md`).

### Изменено

- CI настроен на проверку сборки, тестов, Markdown-линтера и тестов песочницы.
- Docker-образ API переведён на `pnpm deploy --prod` (560 МБ вместо 904 МБ), Prisma CLI для `db:migrate` ставится глобально.

## [0.1.0] - 2026-11-12

- Инициализация репозитория.
