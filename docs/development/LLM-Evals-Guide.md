# LLM Evals — методика оценки качества промптов

Документ описывает золотые датасеты Sprint 29 (`EVAL-29.1`), формат кейсов,
метрики LLM-as-a-Judge и порядок прогона в CI. Основание —
[ROADMAP-V2.md](ROADMAP-V2.md), Этап 4.

## Состав датасетов

Каталог `evals/datasets/` содержит по одному файлу на бизнес-трек `A–L` и
реестр `index.json`. Каждый файл — объект с полями `trackId`, `title`, `source`
и массивом `cases` (2–3 кейса на трек, всего 36). Реестр фиксирует
`schemaVersion`, релиз, список файлов, обязательные ключи рубрики и порог по
умолчанию.

Связь треков и названий: <https://github.com/iilmchat/ai-skillwharf/blob/main/docs/ecosystem/USE-CASES-GUIDE.md>
(локально: [USE-CASES-GUIDE.md](../ecosystem/USE-CASES-GUIDE.md)).

## Контракт кейса

| Поле | Тип | Описание |
| --- | --- | --- |
| `id` | string | Уникальный ID, например `A-01` или `K-02` |
| `trackId` | string | Трек `A`–`L`, совпадает с файлом |
| `title` | string | Краткое название сценария |
| `input` | string | Входной запрос пользователя на русском языке |
| `expectedTools` | string[] | Ожидаемые вызовы инструментов, например `bitrix24_get_deal` |
| `requiresHitl` | boolean | Ожидается ли остановка на Human-in-the-Loop |
| `rubric.required` | string[] | Обязательные факты и действия в ответе |
| `rubric.forbidden` | string[] | Запрещённые галлюцинации и unsafe-действия |

Пример:

```json
{
  "id": "A-01",
  "trackId": "A",
  "title": "Проверка остатков перед выдачей",
  "input": "Проверь, есть ли на складе товар SKU-1001 для заказа №42...",
  "expectedTools": ["moysklad_check_stock", "stock_report"],
  "requiresHitl": false,
  "rubric": {
    "required": ["Назван точный остаток и склад"],
    "forbidden": ["Списывать товар без одобрения"]
  }
}
```

Важно: `expectedTools` — это ожидаемый *набор* инструментов, а не жёсткая
последовательность; порядок проверяется только там, где это указано в
`rubric.required` (например, «сначала OCR, затем публикация»).

## Метрики LLM-as-a-Judge

Оценка проводится второй моделью по рубрике кейса. Итоговый verdict
преобразуется в `passed: boolean`; рекомендуется фиксировать также `score`
и `reason`.

| Метрика | Что проверяет | Источник |
| --- | --- | --- |
| `tool_selection` | Вызваны ли ожидаемые инструменты, нет ли лишних | `expectedTools` |
| `hitl_compliance` | Остановился ли агент, если `requiresHitl=true` | `requiresHitl` |
| `required_facts` | Все ли обязательные факты присутствуют | `rubric.required` |
| `forbidden_claims` | Нет ли запрещённых утверждений и действий | `rubric.forbidden` |
| `groundedness` | Нет ли выдуманных чисел, дат, клиентов и заказов | `rubric.forbidden` |

Кейс считается пройденным, если выполнены `tool_selection`, `hitl_compliance`
и все пункты `rubric.required`, а `rubric.forbidden` не нарушен.
Aggregated pass rate = пройдено / всего. Порог по умолчанию — `0.85`
(`EVALS_MIN_PASS_RATE`). Промоушен версии B в A/B-эксперименте промптов без
прохода порога запрещён (`EVAL-29.3`).

## Прогон

Валидация структуры (без API):

```bash
pnpm evals:validate
# Эквивалент: node scripts/run-evals.mjs --validate-only
```

Скрипт проверяет наличие всех 12 треков, уникальность ID, непустые `input`,
`expectedTools` и обе части `rubric`, а также совпадение `case.trackId` с
файлом. Exit code `0` означает, что покрытие `A–L` подтверждено.

Прогон через API:

```bash
node scripts/run-evals.mjs \
  --api-url http://127.0.0.1:8080 \
  --prompt-id prompt-1 --version-id v2
EVALS_MIN_PASS_RATE=0.9 node scripts/run-evals.mjs \
  --api-url http://127.0.0.1:8080 --prompt-id prompt-1 --version-id v2
```

История прогонов конкретного промпта доступна через
`GET {api-url}/api/v1/prompts/:id/evals`.

Скрипт отправляет `POST /api/v1/prompts/:id/evals/run` (promptId уходит в path
через `encodeURIComponent`, `versionId` — в теле). Рубрика кейса
преобразуется к плоскому массиву, как в `datasetRubricSchema`: сначала все
`required`, затем все `forbidden` с префиксом «НЕ: ». Тело запроса:

```json
{
  "versionId": "v2",
  "cases": [
    {
      "id": "A-01",
      "trackId": "A",
      "title": "Проверка остатков перед выдачей",
      "input": "...",
      "expectedTools": ["moysklad_check_stock"],
      "requiresHitl": false,
      "rubric": ["Назван остаток", "НЕ: Списывать товар без одобрения"]
    }
  ]
}
```

Ответ — `EvalRunView` из `apps/api/src/prompts/prompt-eval.schemas.ts`:

```json
{
  "id": "run-1",
  "promptId": "prompt-1",
  "versionId": "v2",
  "passRate": 1,
  "passedCases": 36,
  "totalCases": 36,
  "status": "passed",
  "results": [
    {
      "caseId": "A-01",
      "trackId": "A",
      "deterministicPassed": true,
      "toolCallsMatch": true,
      "hitlMatch": true,
      "verdict": { "score": 95, "passed": true, "reasoning": "..." }
    }
  ],
  "createdAt": "2026-11-19T10:00:00.000Z",
  "completedAt": "2026-11-19T10:00:05.000Z"
}
```

Скрипт группирует `results` по трекам, используя `verdict.passed` и
`verdict.reasoning`. На stdout выводится таблица Pass/Fail по каждому треку
и итоговый pass rate. Exit code `1`, если `pass rate < EVALS_MIN_PASS_RATE`,
API вернул ошибку, пропущен или продублирован результат хотя бы одного кейса.

## Интеграция в CI

Шаг валидации датасетов добавлен в job `lint-docs` workflow
[ci.yml](../../.github/workflows/ci.yml) — он не требует API и ловит сломанный
контракт ещё на этапе линтинга. Полный прогон с вызовом API выполняется в
отдельном job'; для него нужны поднятый стек и переменные `EVAL_API_URL` и
`EVAL_PROMPT_ID` (секреты — только в настройках репозитория).

Результаты прогона сохраняются в Grafana (дашборд регрессий, `EVAL-29.4`):
quality score по трекам, деградации и ссылки на конкретные eval-случаи.
