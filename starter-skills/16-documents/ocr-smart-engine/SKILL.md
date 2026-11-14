---
name: "ocr-smart-engine"
version: "1.0.0"
description: "Распознавание сканов через Smart Document Engine или Tesseract."
author:
  name: "SkillWharf Team"
  url: https://skillwharf.ru
dependencies:
  tools: ["ocr_document"]
permissions: ["filesystem", "network"]
pricing:
  model: "Pay-per-Call"
  price: 50.00
  currency: "RUB"
---

Используй `ocr_document`, чтобы получить текст со скана или фотографии.

## Когда использовать

- PDF не содержит текстового слоя (скан), и `extract_pdf` вернул пустой текст.
- Нужно распознать фотографию договора, счёта или справки.
- Нужно передать распознанный текст в `document-analyzer`.

## Порядок действий

1. Уточни файл: инструмент читает каталог `DOCUMENTS_INPUT_DIR`
   (по умолчанию `./documents`); путь `../` и абсолютные пути запрещены.
2. Вызови `ocr_document` с `path` (например, `scan.png`) или `imageBase64`;
   MIME-тип определяется по расширению, для нестандартных файлов задай
   `mimeType` явно.
3. Язык распознавания — `language` (`ru`, `en`, `rus+eng`).
4. Верни текст и поле `engine`: `smart-document-engine` — внешний API,
   `tesseract` — локальный fallback. Если в ответе есть `warnings` про
   недоступный API, скажи об этом пользователю.

## Ограничения

- Внешний OCR работает только при заданных `OCR_API_URL` и `OCR_API_KEY`, а
  домен сервиса должен быть в `OUTBOUND_ALLOWLIST`.
- Tesseract работает без сети, но требует пакет `tesseract-ocr` в образе
  `sandbox-worker` и ограничен таймаутом песочницы.
- Качество распознавания зависит от разрешения скана; результат всегда нужно
  проверять по исходнику.
- Генерация платная: цена указана в манифесте навыка.
