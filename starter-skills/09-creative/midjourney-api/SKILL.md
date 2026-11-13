---
name: midjourney-api
version: 1.2.0
description: Генерация изображений через TTAPI (Midjourney, асинхронные задачи).
author:
  name: SkillWharf Team
  url: https://skillwharf.ru
dependencies:
  tools:
    - generate_image
permissions:
  - network
pricing:
  model: Pay-per-Call
  price: 0.50
---

# Midjourney API (TTAPI)

Генерируй изображения по текстовому описанию через инструмент
`generate_image`. Используется только TTAPI: создание задачи, поллинг
статуса и возврат URL картинки.

## Когда использовать

- Нужна иллюстрация для поста, презентации или лендинга.
- Нужно несколько визуальных вариантов по одному описанию.
- Нужно быстро создать мокап или концепт.

## Порядок действий

1. Собери подробный промпт: объект, стиль, композиция, освещение.
2. Вызови `generate_image` с полем `prompt`.
3. Верни пользователю `imageUrl` и `taskId`; предложи уточнить промпт.

## Ограничения

- Не генерируй изображения с реальными людьми без их согласия.
- Не используй чужие бренды и защищённые авторским правом материалы.
- Генерация платная (Pay-per-Call): списание происходит после успешной
  генерации; при ошибке провайдера средства не списываются.
- Без `MIDJOURNEY_API_KEY` инструмент отвечает 503
  `errors.provider_not_configured`.
- 429/5xx от TTAPI повторяются с экспоненциальным backoff; после
  исчерпания — `errors.provider_rate_limited`/`errors.provider_unavailable`.
- Эндпоинты зафиксированы: `POST https://api.ttapi.io/midjourney/v1/imagine`
  (`TT-API-KEY`, `{prompt, mode:"fast"}`) и
  `GET https://api.ttapi.io/midjourney/v1/fetch?jobId=...`. GoAPI/UseAPI и
  Discord-обёртки не используются.

