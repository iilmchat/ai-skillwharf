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

### Изменено

- CI настроен на проверку сборки, тестов, Markdown-линтера и тестов песочницы.

## [0.1.0] - 2026-11-12

- Инициализация репозитория.
