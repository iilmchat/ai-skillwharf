---
name: messenger-connector
version: 1.0.0
description: Отправка сообщений в Telegram через Bot API.
author:
  name: SkillWharf Team
  url: https://skillwharf.ru
dependencies:
  tools:
    - send_message
permissions:
  - network
pricing:
  model: Free
---

# Messenger Connector

Отправляй сообщения в Telegram через инструмент `send_message`. Бот берётся
из подключения пользователя (Настройки → Интеграции), а если его нет —
из системного `TELEGRAM_BOT_TOKEN`.

## Когда использовать

- Нужно уведомить клиента или коллегу в Telegram.
- Нужно отправить отчёт или напоминание в конкретный чат.
- Нужно показать получателю кнопки со ссылками или callback-действиями.

## Порядок действий

1. Уточни получателя (`chat_id` или `@username`) и текст.
2. Вызови `send_message` с полями `channel: "telegram"`, `to`, `text`.
3. При необходимости добавь `buttons` — до 8 inline-кнопок с `url` или
   `callbackData` (ровно одно из полей на кнопку).
4. Верни пользователю `messageId` и `chatId` из ответа инструмента.

## Ограничения

- Не отправляй сообщения без явного согласия пользователя.
- Не передавай в сообщениях секреты, токены и персональные данные.
- `vk` и `whatsapp` пока не подключены: инструмент вернёт 400
  `errors.invalid_request` для этих каналов.
- Telegram ограничивает частоту запросов (429): повторы выполняются с
  экспоненциальным backoff, после исчерпания — `errors.provider_rate_limited`.
