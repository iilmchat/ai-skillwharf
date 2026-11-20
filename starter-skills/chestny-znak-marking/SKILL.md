---
name: chestny-znak-marking
version: 1.0.0
description: "Проверка кодов маркировки DataMatrix через ГИС МТ «Честный ЗНАК»: статусы марок, сверка отсканированных кодов с партией отгрузки или приёмки и акты о расхождениях для треков A, C, K, L."
author:
  name: SkillWharf Team
  email: team@skillwharf.ru
permissions:
  - network
  - secrets
dependencies:
  tools:
    - marking_check_codes
    - marking_verify_shipment
    - marking_report_violation
pricing:
  model: Pay-per-Call
  price: 15
  currency: RUB
mcp_endpoint: http://marking-mcp:5013
requiresApproval: true
---

# Честный ЗНАК: маркировка DataMatrix

Навык для работы с ГИС МТ «Честный ЗНАК» в треках A (ПВЗ), C (E-commerce),
K (Опт) и L (Производство). Токен и ИНН подключаются в разделе «Интеграции»
и передаются в `marking-mcp` как `X-Marking-Token` / `X-Marking-Inn`.

## Регламент проверки партии

1. Перед отгрузкой или при приёмке вызови `marking_check_codes` со всеми
   отсканированными кодами DataMatrix. Обрати внимание на `status`, владельца
   `ownerInn`, срок годности `expiresAt` и `legalForSale`.
2. Вызови `marking_verify_shipment`, передав коды, `expectedItems` (GTIN и
   ожидаемое количество), направление `shipment`/`receipt` и
   `expectedOwnerInn` из подключения. Сверка детерминированная: она выявляет
   выбывшие марки `RETIRED`/`WRITTEN_OFF`, марки чужого владельца, просрочку,
   а также недостачу и пересорт по GTIN.
3. Если `valid: false`, покажи пользователю `issues` и **остановись**.
   Не отгружай и не принимай партию до решения ответственного сотрудника.
4. Для оформления акта о расхождении или блокировки партии вызови
   `marking_report_violation`. Инструмент имеет политику `approval: 'always'`:
   документ будет отправлен только после явного HITL-одобрения руководителя.

## Правила безопасности

- Никогда не выводи токен ГИС МТ в ответе ассистенту; ИНН показывай только
  в маскированном виде.
- Марка с истёкшим сроком годности или чужим владельцем не допускается
  к обороту независимо от результатов сверки количества.
- `marking_report_violation` — юридически значимое действие: всегда требуй HITL.
