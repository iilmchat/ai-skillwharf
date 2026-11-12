# Roadmap проекта SkillWharf

Этот документ является единым источником истины для отслеживания прогресса. Агенты (OpenCode, Infra) обязаны отмечать выполненные задачи символом `[x]`.

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
* [x] Базовая настройка RBAC (роли `admin`, `user`).

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
* [x] Remote Sandbox Provider (Firecracker/gVisor) вместо docker-сокета.

## Спринт 7: Post-MVP

* [ ] Внедрение реальной ЮKassa вместо mock-провайдера.
* [ ] E2E-тесты сквозных сценариев (auth → chat → skill → billing).
* [ ] Remote Sandbox Provider (Firecracker/gVisor) вместо docker-сокета.
* [ ] Продакшн-провайдеры LLM: GigaChat, YandexGPT, Ollama.
* [ ] Периодический сброс Freemium-лимитов и пагинация истории транзакций.
* [ ] Мониторинг, алертинг и нагрузочное тестирование.
