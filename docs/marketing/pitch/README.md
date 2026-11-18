# Питч-дек SkillWharf

Каталог содержит материалы для презентации платформы инвесторам и Design Partners:

| Файл | Назначение |
| --- | --- |
| `create_pitch.py` | Генератор короткого питча на `python-pptx` (три слайда: проблема, решение, модель Pay-per-Outcome). |
| `SkillWharf_Pitch.pptx` | Сгенерированный короткий питч — редактировать через `create_pitch.py`, а не вручную. |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pptx` | Расширенная презентация «Управляемый AI-Офис для вашего бизнеса» (RU). |
| `SkillWharf-Upravlyaemyj-AI-Ofis-dlya-vashego-biznesa.pdf` | PDF-экспорт расширенной презентации для рассылки. |

## Генерация

Из этого каталога:

```bash
python -m pip install python-pptx
python create_pitch.py
```

Скрипт перезаписывает `SkillWharf_Pitch.pptx`; расширенную презентацию нужно
экспортировать в PDF отдельно из PowerPoint/LibreOffice. Тексты и слайды
короткого питча меняются в `create_pitch.py`.
