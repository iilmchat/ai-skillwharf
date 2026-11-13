---
name: "price-monitor"
version: "1.1.0"
description: "Мониторинг собственных и конкурентных цен через MCP."
author:
  name: "SkillWharf Team"
  url: https://skillwharf.ru
dependencies:
  tools: ["monitor_competitor_prices"]
permissions: ["network"]
---

# Price Monitor

Следи за ценами через инструмент `monitor_competitor_prices`. Ozon отдаёт
собственную цену и (по `productId`) цену конкурента через Pricing API; WB —
собственную цену и ценовой карантин, конкурентные цены MCP-сервер WB не
отдаёт.

## Когда использовать

- Нужно узнать, изменил ли конкурент цену на SKU (Ozon).
- Нужно получить свою текущую цену/скидку (WB/Ozon).
- Нужно отслеживать резкие изменения цен.

## Порядок действий

1. Уточни SKU (`offer_id`/`product_id` для Ozon, `nmId` для WB), маркетплейс
   и при необходимости `productId`.
2. Вызови `monitor_competitor_prices`.
3. Верни собственную цену и цену конкурента; если
   `competitorUnavailableReason` заполнен — объясни, что провайдер её не
   отдаёт, не выдумывай цену.

## Ограничения

- Не меняй цену автоматически без подтверждения пользователя.
- WB не поддерживает конкурентные цены в MCP — инструмент сообщает об этом.
