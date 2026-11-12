---
name: google-workspace
version: 1.0.0
description: Создание отчетов, чтение таблиц, работа с документами.
author:
  name: SkillWharf Team
  url: https://skillwharf.ru
dependencies:
  tools:
    - google_sheets_append
    - google_docs_create
permissions:
  - network
pricing:
  model: Free
---

# Google Workspace

Работай с Google Таблицами и Документами через инструменты
`google_sheets_append` и `google_docs_create`.

## Когда использовать

- Нужно добавить строки в таблицу с отчётом.
- Нужно создать документ с итогами встречи или проекта.
- Нужно подготовить отчёт для команды или клиента.

## Порядок действий

1. Для таблицы вызови `google_sheets_append` с `sheetId` и массивом `values`.
2. Для документа вызови `google_docs_create` с `title` и `content`.
3. Верни пользователю идентификатор таблицы или название документа.

## Ограничения

- Не изменяй чужие таблицы и документы без разрешения владельца.
- Не вставляй в документы секреты и персональные данные.
- Инструменты пока работают в режиме заглушки и возвращают подтверждение
  без реального вызова Google API.
