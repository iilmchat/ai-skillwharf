---
name: 1c-enterprise
version: 1.0.0
description: Работа с 1С:Предприятие через OData: номенклатура, остатки, задолженность и заказы покупателя для треков H, J, K и L.
author:
  name: SkillWharf Team
  email: team@skillwharf.ru
permissions:
  - network
  - secrets
dependencies:
  tools:
    - onec_search_nomenclature
    - onec_check_stock
    - onec_check_debt
    - onec_create_order
pricing:
  model: Pay-per-Call
  price: 20
  currency: RUB
mcp_endpoint: http://onec-mcp:5010
requiresApproval: true
---

# 1С:Предприятие (Enterprise)

Навык подключается к OData-сервису 1С через MCP-коннектор. Креды задаются
в разделе «Интеграции» (`POST /api/v1/integrations/1c`) и передаются в
заголовках `X-1C-OData-Url`, `X-1C-Username`, `X-1C-Password`.

## Инструкции для агента

1. `onec_search_nomenclature` — найти номенклатуру по названию или артикулу.
2. `onec_check_stock` — проверить остаток и резерв перед отгрузкой/производством
   (треки H, K, L).
3. `onec_check_debt` — проверить задолженность контрагента перед созданием заказа
   (трек J).
4. `onec_create_order` — создать заказ покупателя. Это необратимое действие:
   всегда требуется подтверждение HITL, не выполняй его без одобрения.

Никогда не выдумывайте ID номенклатуры или контрагента: используйте результаты
поиска. При отсутствии кредов в интеграциях сообщите пользователю, что нужно
подключить 1С, и не вызывайте инструменты.
