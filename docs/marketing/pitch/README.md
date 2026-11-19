# Питч-дек SkillWharf (v1.0.0-ga)

Каталог содержит материалы для презентации платформы инвесторам и Design
Partners. Актуальный статус продукта — **релиз `v1.0.0-ga` (Production Ready)**,
этапы 0–3 дорожной карты завершены.

| Файл | Назначение |
| --- | --- |
| `create_pitch.py` | Генератор короткого питча на `python-pptx` (6 слайдов: релиз, проблема, решение, экосистема, безопасность, Control Plane). |
| `SkillWharf_Pitch.pptx` | Сгенерированный короткий питч под `v1.0.0-ga` — редактировать через `create_pitch.py`, а не вручную. |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pptx` | Расширенная презентация «Управляемый AI-Офис для вашего бизнеса» (RU), созданная в раннем MVP. Артефакт исторического периода — содержит пилотные формулировки. |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pdf` | PDF-экспорт расширенной презентации для рассылки; тоже отражает ранний пилот. Для новых питчей используйте `SkillWharf_Pitch.pptx`. |

## Содержимое короткого питча

1. **SkillWharf — релиз v1.0.0-ga (Production Ready)** — self-hosted, данные и
   биллинг на стороне клиента; интерактивное демо 12 отраслей на
   <https://skillwharf.ru>.
2. **Проблема** — ИИ-агенты как «чёрный ящик»: опасные действия,
   галлюцинации, скрытые расходы на токены.
3. **Решение: Управляемый AI-Офис** — 12 готовых треков `A–L` (включая Опт `K`
   и Производство `L`), Human-in-the-Loop, интеграции Битрикс24 и МойСклад,
   Ozon/WB, Telegram, Google Workspace, аудит в append-only Ledger.
4. **Экосистема и монетизация** — публичный Marketplace с подписью Ed25519,
   подписки Free / Pro / Team / Enterprise, Pay-per-Call, Pay-per-Outcome с
   эскроу ЮKassa и Revenue Share 85/15.
5. **Enterprise-безопасность** — Docker / Firecracker microVM / Kubernetes
   gVisor, SNI/Host Egress-прокси, шифрование ключей с keyId и ротацией,
   зашифрованные offsite-бэкапы с SHA-256.
6. **Control Plane v2 и масштабируемая память** — A/B-тестирование промптов,
   per-model тарифы LLM, метаданные памяти, pgvector/Qdrant, OIDC-SSO и Tempo.

## Пересборка

Нужны Python 3 и `python-pptx`. Скрипт запускается из любого каталога и
записывает результат рядом с собой:

```bash
python -m pip install python-pptx
python3 docs/marketing/pitch/create_pitch.py
```

Тексты и слайды меняются в `create_pitch.py`. Для экспорта в PDF из расширенной
презентации или короткого питча нужен LibreOffice/PowerPoint — в CI и в этом
окружении он не требуется.
