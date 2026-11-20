# Питч-дек SkillWharf (v3.0.0)

Каталог содержит материалы для презентаций платформы инвесторам, партнёрам и
Design Partners. Актуальный статус — **релиз `v3.0.0`**, завершены все 11
этапов дорожной карты и 44 спринта.

| Файл | Назначение |
| --- | --- |
| `create_pitch.py` | Генератор короткого питча на `python-pptx` (7 слайдов под `v3.0.0`). |
| `SkillWharf_Pitch.pptx` | Сгенерированный питч — редактировать через `create_pitch.py`, а не вручную. |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pptx` | Расширенная презентация раннего MVP. Исторический артефакт с пилотными формулировками. |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pdf` | PDF-экспорт расширенной презентации; также отражает ранний пилот. Для новых питчей используйте `SkillWharf_Pitch.pptx`. |

Продающее КП и чек-лист пилота: [Sales One-Pager и Design Partner Checklist](../Sales-One-Pager-and-Pilot-Checklist.md).

## Содержимое питча v3.0.0

1. **SkillWharf v3.0.0** — управляемый AI-Офис для российского бизнеса,
   Self-Hosted & Enterprise, демо 12 отраслей на <https://skillwharf.ru>.
2. **Проблема и решение** — почему чат-боты не работают в B2B (галлюцинации,
   утечки ПДн, разрыв с 1С и ЭДО) и ответ SkillWharf: HITL, песочница, 152-ФЗ.
3. **Стек для бизнеса РФ** — 1С:Предприятие (OData), Контур.Диадок / СБИС,
   ГИС МТ «Честный ЗНАК» (DataMatrix), Битрикс24, МойСклад, Ozon и WB.
4. **Омниканальность и UX** — Telegram-бот с inline-HITL, Mini App, VK Teams /
   Пачка / Яндекс Мессенджер, Artifacts Canvas, голосовой ввод и Cron-сводки.
5. **152-ФЗ и бюджет** — PiiMaskingService, Vault / Yandex Cloud KMS, песочницы
   Docker/Firecracker, Smart Model Cascade и Semantic Cache.
6. **No-Code и Маркетплейс** — `/app/builder`, 12 треков A–L, Eval-рейлсы,
   Developer Portal с аудитом и Revenue Share 85/15.
7. **Внедрение за 3 дня и тарифы** — пилот Design Partner и модель Open Source
   Core / Pro / Team / Enterprise On-Premise.

## Пересборка

Нужны Python 3 и `python-pptx`. Скрипт запускается из любого каталога и
записывает результат рядом с собой:

```bash
python -m pip install python-pptx
python3 docs/marketing/pitch/create_pitch.py
```

Тексты и слайды меняются в `create_pitch.py`. Для экспорта в PDF нужен
LibreOffice/PowerPoint — для сборки `.pptx` он не требуется.

## Проверка

После пересборки убедитесь, что в презентации ровно 7 слайдов:

```bash
python3 -c "from pptx import Presentation; print(len(Presentation('docs/marketing/pitch/SkillWharf_Pitch.pptx').slides))"
```
