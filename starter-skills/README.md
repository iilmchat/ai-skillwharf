# Starter Skills

Стартовый каталог навыков SkillWharf «из коробки». Каждый навык — это
директория с файлом `SKILL.md`: YAML frontmatter с метаданными и Markdown-тело
с инструкциями для LLM. Формат описан в
[Manifest-Specification.md](../docs/ecosystem/Manifest-Specification.md).

## Состав каталога

| Навык | Каталог | Назначение | Монетизация | Разрешения | Tools |
| --- | --- | --- | --- | --- | --- |
| `tavily-search` | [`01-external-data/tavily-search`](01-external-data/tavily-search/SKILL.md) | Поиск в интернете и проверка фактов по первоисточникам | Pay-per-Call, 0.10 RUB за вызов | `network` | `web_search`, `web_fetch` |
| `github` | [`02-work-tools/github`](02-work-tools/github/SKILL.md) | Issues, pull requests и статусы CI через `gh` CLI | Freemium: 50 вызовов бесплатно, далее 0.02 RUB | `network`, `shell` | `exec` |
| `cron-automation` | [`03-automation/cron-automation`](03-automation/cron-automation/SKILL.md) | Регулярные задачи и напоминания через `cron_manager` | Pay-per-Call, 0.05 RUB за вызов | — | `cron_manager` |
| `skill-vetter` | [`04-security/skill-vetter`](04-security/skill-vetter/SKILL.md) | Аудит навыка на опасные паттерны перед установкой | Free | `filesystem` | `read_file` |
| `code-runner` | [`05-utility/code-runner`](05-utility/code-runner/SKILL.md) | Выполнение Python/shell-кода в изолированной песочнице | Pay-per-Call, 0.05 RUB за вызов | `shell` | `execute_sandbox_code` |
| `dzen-article` | [`11-content/dzen-article`](11-content/dzen-article/SKILL.md) | Markdown-черновик статьи для Дзен с HITL и Pay-per-Outcome | Pay-per-Outcome, 100 RUB за статью | `filesystem` | `publish_to_dzen` |
| `fact-checker` | [`12-content/fact-checker`](12-content/fact-checker/SKILL.md) | Проверка фактов через Tavily и сравнение источников | Pay-per-Call, 30 RUB за проверку | `network` | `check_facts` |
| `resume-screener` | [`13-hr/resume-screener`](13-hr/resume-screener/SKILL.md) | Разбор резюме и сопоставление с требованиями вакансии | Pay-per-Outcome, 50 RUB за кандидата | — | `screen_resume` |
| `document-analyzer` | [`14-legal/document-analyzer`](14-legal/document-analyzer/SKILL.md) | Реквизиты договора: суммы, даты, стороны, ИНН/КПП/ОГРН | Pay-per-Outcome, 500 RUB за договор | `filesystem` | `extract_document_data` |
| `pdf-extractor` | [`16-documents/pdf-extractor`](16-documents/pdf-extractor/SKILL.md) | Текст и таблицы из PDF | Pay-per-Call, 30 RUB за файл | `filesystem` | `extract_pdf` |
| `docx-writer` | [`16-documents/docx-writer`](16-documents/docx-writer/SKILL.md) | Отчёт в Word (DOCX) | Pay-per-Call, 10 RUB за файл | `filesystem` | `write_docx` |
| `ocr-smart-engine` | [`16-documents/ocr-smart-engine`](16-documents/ocr-smart-engine/SKILL.md) | Распознавание сканов (Smart Document Engine / Tesseract) | Pay-per-Call, 50 RUB за документ | `filesystem`, `network` | `ocr_document` |

## Модели монетизации

- **Free** — вызовы не списывают средства. Подходит для служебных навыков,
  которые не создают нагрузки (например, `skill-vetter`).
- **Pay-per-Call** — фиксированная цена за каждый вызов инструмента. Сумма
  списывается через `BillingService.checkAndChargeSkill()` до запуска
  песочницы; при недостатке средств вызов отклоняется.
- **Freemium** — первые `freeCallsLimit` вызовов бесплатны, дальше действует
  цена за вызов. Использованные бесплатные вызовы учитываются в таблице
  `SkillUsage` (поле `callsCount`). Так устроен `github`: базовые чтения не
  должны упираться в paywall.

Модель и цена задаются в блоке `pricing` манифеста. Допустимые значения:
`Free`, `Pay-per-Call`, `Subscription`, `Freemium`.

Сейчас Gateway списывает фиксированную ставку за вызов песочницы
(`ChatService`), а поля `price` и `freeCallsLimit` из манифеста — декларация
для каталога и будущего per-skill биллинга.

## Установка

Установка выполняется через REST API и доступна только администратору: нужен
JWT с ролью `admin`. API по умолчанию слушает `http://localhost:3000`, все
эндпоинты имеют префикс `/api/v1`.

```bash
export API="http://localhost:3000"

# JWT администратора
export TOKEN=$(curl -sS -X POST "$API/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"<пароль>"}' | jq -r .accessToken)

# Установка навыка: в поле fileContent передаётся весь текст SKILL.md
curl -sS -X POST "$API/api/v1/skills/install" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -Rs '{fileContent: .}' < starter-skills/01-external-data/tavily-search/SKILL.md)"
```

Повторная установка навыка с тем же `name` обновляет запись и снова включает
его. Остальные навыки устанавливаются аналогично — достаточно заменить путь к
файлу.

### Управление установленными навыками

```bash
# Каталог установленных навыков
curl -sS "$API/api/v1/skills" -H "Authorization: Bearer $TOKEN"

# Выключить навык (id берётся из ответа каталога)
curl -sS -X PATCH "$API/api/v1/skills/<id>/toggle" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isEnabled":false}'

# Удалить навык
curl -sS -X DELETE "$API/api/v1/skills/<id>" -H "Authorization: Bearer $TOKEN"
```

### Проверка манифестов

Тест `apps/api/src/skills/starter-skills.spec.ts` читает все `SKILL.md` из
этого каталога и валидирует их схемой `SkillManifestSchema`:

```bash
pnpm --filter api test
```

## Безопасность

- `github` запрашивает разрешение `shell` и запускает `gh` в песочнице —
  устанавливайте его только в доверенном окружении.
- `code-runner` выполняет произвольный shell/Python-код в песочнице без сети
  и с read-only корневой файловой системой; таймаут — 10 секунд.
- Перед установкой сторонних навыков используйте `skill-vetter`: он ищет
  `curl | bash`, `rm -rf`, `eval`, утечки секретов и другие опасные паттерны.
- Разрешения из манифеста должен подтверждать администратор при установке.
