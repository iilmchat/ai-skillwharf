---
name: "docx-writer"
version: "1.0.0"
description: "Генерация отчётов в Word (DOCX)."
author:
  name: "SkillWharf Team"
  url: https://skillwharf.ru
dependencies:
  tools: ["write_docx"]
permissions: ["filesystem"]
pricing:
  model: "Pay-per-Call"
  price: 10.00
  currency: "RUB"
---

Используй `write_docx`, чтобы собрать отчёт в Word из готовых данных.

## Когда использовать

- Нужно отдать пользователю документ `.docx`, а не Markdown.
- Нужен отчёт с заголовками, списками и таблицей по результатам других
  инструментов (`unit-economics`, `pdf-extractor`, `document-analyzer`).
- Нужно сохранить результат в файл, который откроется в Word, LibreOffice и
  Google Docs.

## Порядок действий

1. Собери содержимое: `title`, необязательный `subtitle` и `blocks`.
2. Блоки: `{ "type": "heading", "text": "..." }` (уровень 1–3),
   `{ "type": "paragraph", "text": "..." }`,
   `{ "type": "bullets", "items": ["..."] }`,
   `{ "type": "table", "headers": ["..."], "rows": [["..."]] }`.
3. Вызови `write_docx`, при необходимости задай `filename` (`report.docx`).
4. Сообщи пользователю путь из ответа: файл лежит в `DOCUMENTS_OUTPUT_DIR`
   (по умолчанию `./docx-output`).

## Ограничения

- Имя файла — только буквы, цифры, точка и дефис; путь внутри каталога задать
  нельзя.
- Не вставляй в документ секреты и токены: файл сохраняется на диск без
  шифрования.
- Таблицы простые: без объединённых ячеек и формул.
- Генерация платная: цена указана в манифесте навыка.
