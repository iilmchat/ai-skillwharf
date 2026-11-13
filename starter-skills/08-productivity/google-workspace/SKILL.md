---
name: google-workspace
version: 1.1.0
description: Таблицы, документы и календарь Google Workspace через OAuth.
author:
  name: SkillWharf Team
  url: https://skillwharf.ru
dependencies:
  tools:
    - google_sheets_append
    - google_docs_create
    - google_calendar_create
permissions:
  - network
pricing:
  model: Free
---

# Google Workspace

Работай с Google Таблицами, Документами и Календарём через инструменты
`google_sheets_append`, `google_docs_create` и `google_calendar_create`.
Пользователь подключает аккаунт в Настройках → Интеграции (OAuth); инструменты
работают от его имени, access-token обновляется автоматически по refresh-token.

## Когда использовать

- Нужно добавить строки в таблицу с отчётом.
- Нужно создать документ с итогами встречи или проекта.
- Нужно запланировать встречу с участниками.

## Порядок действий

1. Таблица: `google_sheets_append` с `sheetId`, массивом `values` и
   необязательным `range` (по умолчанию `A1`).
2. Документ: `google_docs_create` с `title` и `content` — вернёт `documentId`
   и ссылку.
3. Календарь: `google_calendar_create` с `summary`, `start`/`end` в ISO 8601,
   описанием и списком email участников; вернёт `eventId` и `htmlLink`.
4. Верни пользователю идентификатор/ссылку созданного объекта.

## Ограничения

- Не изменяй чужие таблицы и документы без разрешения владельца.
- Не вставляй в документы секреты и персональные данные.
- Без подключённого Google инструменты возвращают
  `errors.provider_auth_required`; после истечения/отзыва токена нужно заново
  пройти OAuth.
- Google ограничивает частоту запросов (429): повторы идут с экспоненциальным
  backoff, после исчерпания — `errors.provider_rate_limited`.
