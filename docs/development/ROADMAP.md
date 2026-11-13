# Roadmap проекта SkillWharf

**Статус:** Sprint 1–13 закрыты. Актуальный план с Sprint 14 — в [SPRINTS-14-PLUS.md](SPRINTS-14-PLUS.md).
Агенты обязаны отмечать выполненные задачи символом `[x]`.

## Спринт 1: Инфраструктура и БД

* [x] Инициализация монорепозитория и CI (pnpm, GitHub Actions).
* [x] Настройка Docker (API + PostgreSQL) и базовой песочницы.
* [x] Реструктуризация документации.
* [x] Настройка ORM (Prisma) и схемы БД (`User`, `Session`, `Transaction`).
* [x] Реализация эндпоинта `/health` (проверка БД).
* [x] Настройка скрипта миграций `db:migrate`.

## Спринт 2: Аутентификация и Безопасность

* [x] Модуль регистрации пользователей (Email + Password, Argon2).
* [x] Модуль логина и выдачи JWT (Access + Refresh).
* [x] Middleware для защиты эндпоинтов (Guards в NestJS).
* [x] Базовая настройка RBAC (роли `admin`, `user`, `owner`).

## Спринт 3: Агентный Рантайм (Core)

* [x] Интеграция LangGraph в NestJS.
* [x] WebSocket-хаб для общения с агентами.
* [x] Интеграция с LLM (OpenAI-совместимый фасад, GigaChat/YandexGPT).
* [x] Сохранение истории сессий и сообщений в БД.

## Спринт 4: Система расширений (Sandbox)

* [x] Загрузка и валидация `SKILL.md` (Zod-схемы).
* [x] Интеграция с Sandbox Provider (Docker API для запуска плагинов).
* [x] Тестовый запуск простого Skill в изолированной среде.

## Спринт 5: Биллинг и Ledger

* [x] Реализация Billing Abstraction Layer (интерфейсы).
* [x] Модуль ЮKassa (адаптер).
* [x] Внедрение Paywall (блокировка вызова Skill без баланса).
* [x] Запись транзакций в Append-only Ledger.

## Спринт 6: Система расширений / Интеграция LLM

* [x] Хранение и установка Skills через REST API (каталог навыков в БД).
* [x] Интеграция Sandbox в LangGraph: инструмент `execute_sandbox_code` и цикл tool calls.
* [x] Paywall для вызовов песочницы (списание через `BillingService.chargeForSkill`).
* [x] Управление навыками: включение/отключение и удаление (CRUD).
* [x] Реальные LLM-провайдеры: GigaChat, YandexGPT, Ollama через OpenAI-совместимый фасад.
* [x] E2E-тесты сквозных сценариев (auth → chat → skill → billing).
* [x] Изоляция Sandbox: `sandbox-worker` без Docker Socket в API (ADR 0005) — заменяет прежний план Firecracker; сам Firecracker — post-pilot.

## Спринт 7: Post-MVP

* [x] Внедрение реальной ЮKassa вместо mock-провайдера.
* [x] Продакшн-провайдеры LLM: GigaChat, YandexGPT, Ollama.
* [x] Мониторинг, алертинг (Prometheus + Grafana, Basic Auth).
* [ ] Периодический сброс Freemium-лимитов → Sprint 15.
* [ ] Пагинация истории транзакций → Sprint 15.
* [ ] Нагрузочное тестирование → Sprint 17.

## Спринт 8: Интеграция бизнес-треков

* [x] Создание документов для 10 треков (A–J).
* [x] Mock-навыки для интеграции с внешними API (мессенджеры, Google, Midjourney).
* [x] Реальные MCP-серверы Ozon/WB (KI-011 закрыт).
* [ ] Реальные Telegram Bot API и Google Workspace → Sprint 18.
* [ ] Реальные финансы Ozon/WB и Midjourney → Sprint 19.
* [ ] Реальные PDF/OCR/DOCX, fact-checker, resume-screener → Sprint 20.

## Спринты 9–13: Production Readiness (закрыты)

* [x] Auth rate-limit, helmet, CORS.
* [x] Восстановление refresh-токена в UI.
* [x] `sandbox-worker` без Docker Socket в API (ADR 0005).
* [x] Admin-only `topup`, Cost Guardrails с жёстким дневным лимитом токенов.
* [x] Верификация вебхуков ЮKassa через реальный API.
* [x] pgvector для долговременной памяти.
* [x] Prometheus + Grafana с Basic Auth, ротация бэкапов БД.
* [x] Атомарный жёсткий лимит токенов (Prisma `updateMany`), стриминг GigaChat.
* [x] RAG-панель за feature-флагом (ждёт read-API в Sprint 14).

## Sprint 14+ (пилот)

См. [SPRINTS-14-PLUS.md](SPRINTS-14-PLUS.md).
