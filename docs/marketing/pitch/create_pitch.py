"""Генератор питч-дека SkillWharf под релиз v3.0.0.

Запуск из любого каталога:
    python3 docs/marketing/pitch/create_pitch.py

Результат — SkillWharf_Pitch.pptx рядом со скриптом. Для редактирования
меняйте тексты слайдов ниже, а не готовый .pptx.
"""

from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

OUTPUT = Path(__file__).resolve().parent / "SkillWharf_Pitch.pptx"
PURPLE = RGBColor(107, 56, 212)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)


def create_slide(title, subtitle, bullets, footer=None):
    """Один слайд: заголовок, подзаголовок и маркированный список."""
    slide = prs.slides.add_slide(prs.slide_layouts[1])

    title_shape = slide.shapes.title
    title_shape.text = title
    title_p = title_shape.text_frame.paragraphs[0]
    title_p.font.size = Pt(34)
    title_p.font.bold = True
    title_p.font.color.rgb = PURPLE

    tf = slide.placeholders[1].text_frame
    tf.text = subtitle
    tf.paragraphs[0].font.size = Pt(21)
    tf.paragraphs[0].font.bold = True

    for bullet in bullets:
        p = tf.add_paragraph()
        p.text = bullet
        p.font.size = Pt(18)
        p.space_before = Pt(12)

    if footer:
        box = slide.shapes.add_textbox(
            Inches(0.6), Inches(6.7), Inches(12.1), Inches(0.5)
        )
        p = box.text_frame.paragraphs[0]
        p.text = footer
        p.alignment = PP_ALIGN.LEFT
        p.font.size = Pt(12)
        p.font.color.rgb = RGBColor(110, 110, 110)

    return slide


# Слайд 1 — титульный.
create_slide(
    "SkillWharf v3.0.0",
    "Управляемый AI-Офис для российского бизнеса · Self-Hosted & Enterprise",
    [
        "🛡️ Автономные агенты с Human-in-the-Loop и полным аудитом действий",
        "🏢 Данные, секреты и биллинг на стороне клиента (152-ФЗ)",
        "🌐 Демо 12 отраслей и пилот Design Partner: skillwharf.ru",
        "✅ Все 11 этапов дорожной карты и 44 спринта завершены",
    ],
    "https://skillwharf.ru",
)

# Слайд 2 — проблема и решение.
create_slide(
    "Почему чат-боты не работают в B2B — и что делает SkillWharf",
    "Типовые барьеры корпоративного внедрения и наш ответ:",
    [
        "❌ Галлюцинации → ✅ Eval-рейлсы, LLM-as-a-Judge и гейт качества перед промоушеном",
        "❌ Утечка ПДн → ✅ авто-маскирование 152-ФЗ до отправки во внешнюю LLM",
        "❌ Разрыв с учётом → ✅ нативные коннекторы 1С, ЭДО и маркировки",
        "❌ Неконтролируемые действия → ✅ HITL, изолированная песочница, RBAC/ABAC",
    ],
)

# Слайд 3 — стек для РФ.
create_slide(
    "Стек для бизнеса РФ: нативные коннекторы",
    "Готовые интеграции с корпоративным контуром из коробки:",
    [
        "📦 1С:Предприятие 8.3 через OData (УТ / Бухгалтерия / ERP)",
        "📄 ЭДО: Контур.Диадок и СБИС — УПД, акты, сверка с заказом, пакет на КЭП",
        "🏷️ ГИС МТ «Честный ЗНАК»: проверка DataMatrix перед отгрузкой и приёмкой",
        "🔗 Битрикс24, МойСклад, Ozon, Wildberries + event-driven webhook-триггеры",
    ],
)

# Слайд 4 — омниканальность и UX.
create_slide(
    "Омниканальность и UX нового поколения",
    "Агент работает там, где команда — без потери контекста и контроля:",
    [
        "💬 Telegram-бот: голос, фото накладных и inline-кнопки «Одобрить / Отклонить»",
        "📱 Telegram Mini App для мониторинга AI-Офиса и HITL в мобильном",
        "🏢 VK Teams, Пачка, Яндекс Мессенджер — единый шлюз для закрытых контуров",
        "🧾 Artifacts Canvas с правкой и экспортом, Execution DAG Inspector, голос, Cron-сводки",
    ],
)

# Слайд 5 — безопасность и экономика.
create_slide(
    "152-ФЗ и оптимизация бюджета LLM",
    "Соответствие и предсказуемая стоимость владения:",
    [
        "🔐 PiiMaskingService: ФИО, телефоны, паспорта, ИНН → токены с локальной демаскировкой",
        "🗝️ HashiCorp Vault / Yandex Cloud KMS, ротация ключей, зашифрованные бэкапы",
        "🧱 Изоляция Docker / Firecracker microVM / Kubernetes gVisor, SNI Egress-прокси",
        "⚡ Smart Model Cascade + Semantic Cache — экономия до 40% на LLM-затратах",
    ],
)

# Слайд 6 — No-Code и маркетплейс.
create_slide(
    "No-Code конструктор и Маркетплейс",
    "Масштабирование экспертизы без программирования:",
    [
        "🧩 Сборка ролей и регламента HITL без кода — /app/builder",
        "🏭 12 отраслевых треков (A–L) от ПВЗ и HR до Опта и Производства",
        "📈 Eval-рейлсы качества и сквозная наблюдаемость каждого шага агента",
        "🧪 Developer Portal с аудитом безопасности навыков и Revenue Share 85/15",
    ],
)

# Слайд 7 — внедрение и тарифы.
create_slide(
    "Внедрение за 3 дня и тарифы",
    "От пилота до промышленной эксплуатации — без долгих интеграций:",
    [
        "1️⃣ День 1: подключение 1С/ЭДО и выбор отраслевого трека A–L",
        "2️⃣ День 2: настройка ролей, HITL и каналов (Telegram / корпоративные)",
        "3️⃣ День 3: Eval-прогон, пилотная сводка и отчёт о экономии",
        "💼 Open Source Core · Pro · Team · Enterprise On-Premise",
    ],
    "skillwharf.ru — заявка на Design Partner",
)

prs.save(OUTPUT)
print(f"Файл {OUTPUT.name} успешно создан: {OUTPUT}")
