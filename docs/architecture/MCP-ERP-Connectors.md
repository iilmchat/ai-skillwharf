# MCP-коннекторы Битрикс24 и МойСклад (треки K/L)

Документ фиксирует контракт между инструментами агента в API и MCP-серверами
`bitrix24-mcp` (порт 5003) и `moysklad-mcp` (порт 5004). Серверы описаны в
`infra/mcp/bitrix24` и `infra/mcp/moysklad`; здесь — только то, на что
опирается Gateway.

## Транспорт

- MCP HTTP/SSE: `GET /sse` отдаёт `event: endpoint`, дальше JSON-RPC идёт
  POST-запросами на этот endpoint. Клиент — `apps/api/src/agent/tools/mcp-client.ts`.
- Общая авторизация контейнеров — `MCP_AUTH_TOKEN` (Bearer на `/sse`).
- Ключи провайдеров живут в окружении MCP-контейнеров, а не в API:
  `BITRIX24_WEBHOOK_URL` (Битрикс24), `MOYSKLAD_TOKEN` и `MOYSKLAD_BASE_URL`
  (МойСклад).
- Адрес сервера берётся из `mcp_endpoint` манифеста навыка; fallback —
  `BITRIX24_MCP_URL`/`MOYSKLAD_MCP_URL` (см. ADR 0004).

## Инструменты агента → действия MCP

| Инструмент агента | Действие MCP | Параметры MCP | Ответ |
| --- | --- | --- | --- |
| `bitrix24_get_deal` | `crm_deal_get` | `{ id }` | `{ result: {...}, time }` |
| `bitrix24_update_deal` | `crm_deal_update` | `{ id, fields: { STAGE_ID?, COMMENTS? } }` | `{ result: true }` |
| `moysklad_check_stock` | `product_get` | `{ id }` | карточка товара (`stock`, `reserve`) |
| `moysklad_get_cost` | `product_get` | `{ id }` | карточка товара (`buyPrice.value`, копейки) |
| `moysklad_create_order` | `customer_order_create` | `{ payload: { description, positions[] } }` | созданный заказ (`id`, `name`, `sum`) |

Имена действий должны совпадать с `tools/list` MCP-сервера: Gateway
отклоняет вызов действия, которого нет в discovery (KI-027).

## Схемы и ошибки

- Аргументы инструментов — строгие Zod-схемы (`tool-schemas.ts`), политики
  (`tool-policies.ts`) повторяют их и запрещают лишние ключи.
- Для действий с вложенными параметрами (`fields`, `payload`) Gateway
  проверяет конверт вызова и применяет строгую схему действия; неизвестные
  действия остаются на плоской структурной схеме.
- Ответы провайдеров нормализуются Zod-схемами в `erp-tools.ts`; не-JSON
  ответ, ошибка провайдера или расхождение схемы превращаются в 502
  `errors.mcp_provider`. HTTP-статус (401/429 и т.п.) сохраняется в тексте
  ошибки, если MCP-сервер его передал.
- 401/403 не ретраятся, 5xx — одна повторная попытка (`McpGateway`).

## HITL и монетизация

- `bitrix24_update_deal` — `approval: 'final-stage'`: подтверждение нужно для
  перехода в `WON` (необратимый финал сделки).
- `moysklad_create_order` — `approval: 'always'`: документ на складе не
  откатывается.
- Чтение сделки, остатков и себестоимости помечено `approval: 'none'` и не
  останавливает граф, даже если навык целиком требует подтверждения.
- Runtime выполняет необратимый вызов только при свежем (по умолчанию 10
  минут) `approved`-решении `PendingApproval` для этого инструмента.
- Оба навыка — Pay-per-Call (15 ₽/вызов); списание идёт после успешного
  ответа MCP.

## Остаточные ограничения

- HITL включается по имени инструмента, поэтому `bitrix24_update_deal`
  спрашивает подтверждение и для промежуточных стадий (KI-079).
- Заказ создаётся без организации и контрагента — JSON API 1.2 их требует
  (KI-080).
- Остаток берётся из карточки товара, без разбивки по складам (KI-081).
- Credentials общие на контейнер, без per-user подключения (KI-077).
