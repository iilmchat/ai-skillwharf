# SkillWharf (СкиллВерфь)

Российский self-hosted аналог OpenClaw для развёртывания автономных ИИ-агентов с долговременной памятью, выполнением сложных задач и взаимодействием через мессенджеры, веб и CLI.

**Стек:** TypeScript (Node.js 24+) · NestJS · Fastify · LangGraph · PostgreSQL (pgvector) · React · Docker.

## Ключевые возможности

- **Автономные агенты:** Сохранение состояния и продолжение работы после перезапуска.
- **Три уровня расширяемости:** Tools (действия), Skills (инструкции), Plugins (исполняемый код).
- **Безопасность:** Выполнение сторонних плагинов в изолированной песочнице (Firecracker/gVisor).
- **Монетизация:** Встроенный биллинг (Pay-per-Call, Subscription), поддержка ЮKassa, Ledger транзакций.

## Документация

Вся проектная документация находится в директории [`docs/`](docs/README.md):

- [Архитектура и ADR](docs/architecture/README.md)
- [Система расширений](docs/ecosystem/Manifest-Specification.md)
- [Биллинг и транзакции](docs/billing/Billing-Flows.md)
- [Безопасность и Threat Model](docs/security/Threat-Model.md)
- [Эксплуатация и развёртывание](docs/operations/Deployment-Runbook.md)

## Быстрый старт (Docker)

```bash
cp .env.example .env
# Отредактируйте .env (пароли, ключи API)
docker compose up -d --build
```

После старта:

| Сервис | Адрес |
| --- | --- |
| UI (web) | <http://localhost:8080> |
| API Gateway | <http://localhost:3001/api/v1> |
| Healthcheck API | <http://localhost:3001/api/v1/health> |

Остановить стек: `docker compose down` (с данными БД — `docker compose down -v`).

## Разработка

```bash
# Установка зависимостей
pnpm install

# Запуск тестов
pnpm test

# Линтинг документации
pnpm run lint:docs
```

## Лицензия

Open Source (Core). См. файл `LICENSE`.
