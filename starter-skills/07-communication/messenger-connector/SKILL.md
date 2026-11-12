---
name: messenger-connector
version: 1.0.0
description: Отправка сообщений в Telegram/VK/WhatsApp.
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

Отправляй сообщения в Telegram, VK и WhatsApp через инструмент
`send_message`.

## Когда использовать

- Нужно уведомить клиента или коллегу в мессенджере.
- Нужно отправить отчёт или напоминание в конкретный канал.
- Нужно продублировать сообщение в несколько каналов.

## Порядок действий

1. Уточни канал (`telegram`, `vk`, `whatsapp`), получателя и текст.
2. Вызови `send_message` с полями `channel`, `to`, `text`.
3. Верни пользователю подтверждение отправки.

## Ограничения

- Не отправляй сообщения без явного согласия пользователя.
- Не передавай в сообщениях секреты, токены и персональные данные.
- Инструмент пока работает в режиме заглушки и не выполняет реальную
  отправку.
