# MCP-коннекторы Битрикс24 и МойСклад (треки K/L)

Документ фиксирует контракт между инструментами агента в API и MCP-серверами
`bitrix24-mcp` (порт 5003) и `moysklad-mcp` (порт 5004). Серверы описаны в
`infra/mcp/bitrix24` и `infra/mcp/moysklad`; здесь — только то, на что
опирается Gateway.

## Транспорт

- MCP HTTP/SSE: `GET /sse` отдаёт `event: endpoint`, дальше JSON-RPC идёт
  POST-запросами на этот endpoint. Клиент — `apps/api/src/agent/tools/mcp-client.ts`.
- Общая авторизация контейнеров — `MCP_AUTH_TOKEN` (Bearer на `/sse`).
- **Per-request креды (MCP-24.1):** Gateway передаёт их заголовками
  `X-Bitrix24-Webhook-Url`, `X-Moysklad-Token`, `X-Ozon-Client-Id`,
  `X-Ozon-Api-Key`, `X-Wb-Api-Token`. `bitrix24-mcp` и `moysklad-mcp` читают
  заголовок на `GET /sse` и могут принять его повторно на `POST /messages`;
  значения не логируются и не попадают в ошибки. Если заголовка нет —
  используется env контейнера (fallback). Некорректный webhook Битрикс24
  отклоняется с HTTP `400`.
- `MCP_ALLOW_MISSING_KEYS=1` по умолчанию в `docker-compose.mcp.yml`: контейнер
  стартует без глобальных секретов, когда креды приходят per-request.
- Адрес сервера берётся из `mcp_endpoint` манифеста навыка; fallback —
  `BITRIX24_MCP_URL`/`MOYSKLAD_MCP_URL` (см. ADR 0004).

## Инструменты агента → действия MCP

| Инструмент агента | Действие MCP | Параметры MCP | Ответ |
| --- | --- | --- | --- |
| `bitrix24_get_deal` | `crm_deal_get` | `{ id }` | `{ result: {...}, time }` |
| `bitrix24_update_deal` | `crm_deal_update` | `{ id, fields: { STAGE_ID?, COMMENTS? } }` | `{ result: true }` |
| `moysklad_check_stock` | `product_get` | `{ id }` | карточка товара (`stock`, `reserve`) |
| `moysklad_get_cost` | `product_get` | `{ id }` | карточка товара (`buyPrice.value`, копейки) |
| `moysklad_create_order` | `customer_order_create` | `{ payload: { description, organization, agent, positions[] } }` | созданный заказ (`id`, `name`, `sum`) |
| `demand_create` | `demand_create` | `{ payload: { name, agent, positions[] } }` | созданная отгрузка (`id`, `name`) |
| `purchase_order_create` | `purchase_order_create` | `{ payload: { name, agent, positions[] } }` | созданный заказ поставщику (`id`, `name`) |
| `counterparty_balance` | `counterparty_balance` | `{ filter?, limit?, offset? }` | отчёт `/report/counterparty` со строками и пагинацией |
| `bundle_get` | `bundle_get` | `{ id }` или `{ article }` | карточка комплекта/состав изделия |

Новые действия `moysklad-mcp` сейчас доступны в `tools/list`, но не все ещё
имеют отдельные инструменты агента в `tool-schemas.ts`: Gateway продолжает
проверять действие по discovery.

Имена действий должны совпадать с `tools/list` MCP-сервера: Gateway
отклоняет вызов действия, которого нет в discovery (KI-027).

### Поведение `moysklad-mcp` при запросах к JSON API 1.2

- Списочные методы принимают `limit` (1–100) и `offset` (≥0), дополнительно
  `filter`/`search`/`expand` где применимо; `counterparty_balance` — только
  `filter`, `limit`, `offset`.
- `bundle_get` ищет по `id` через `/entity/bundle/{id}` или по артикулу через
  `/entity/bundle?filter=article=...&limit=1`.
- Повтор: не более двух попыток с экспоненциальной задержкой (200 мс, затем
  400 мс) на HTTP 429/5xx и сетевые ошибки. 4xx (кроме 429) не повторяются.

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
- Заказ создаётся с организацией и контрагентом из
  `MOYSKLAD_DEFAULT_ORGANIZATION_ID`/`MOYSKLAD_DEFAULT_AGENT_ID`; без них
  инструмент отвечает 503 `errors.provider_not_configured` (автоматический
  маппинг контрагента из сделки — следующий шаг).
- Остаток берётся из карточки товара, без разбивки по складам (KI-081).
- Per-request креды реализованы для `bitrix24-mcp` и `moysklad-mcp` (KI-077
  закрыт). Заголовки доверяются только внутренней compose-сети: обязательна
  авторизация `MCP_AUTH_TOKEN` и передача кредов Gateway, а не клиентом (KI-085).
- Ozon/WB — сторонние пакеты `ozon-mcp-server`/`wb-mcp-server`, в `infra/mcp/`
  нет их исходников; заголовки отправляются Gateway, но серверы всё ещё читают
  env контейнера (остаточный KI-084).
- OAuth, ротация и отзыв токенов на уровне платформы пока не реализованы.
