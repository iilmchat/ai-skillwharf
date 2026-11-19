"""Генератор короткого питч-дека SkillWharf под релиз v1.0.0-ga.

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
    title_p.font.size = Pt(36)
    title_p.font.bold = True
    title_p.font.color.rgb = PURPLE

    tf = slide.placeholders[1].text_frame
    tf.text = subtitle
    tf.paragraphs[0].font.size = Pt(22)
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


# Слайд 1 — статус релиза.
create_slide(
    "SkillWharf — Релиз v1.0.0-ga (Production Ready)",
    "Self-hosted платформа управляемых ИИ-агентов. Этапы 0–3 дорожной карты завершены.",
    [
        "🏠 Данные, агенты и биллинг остаются на вашем сервере (152-ФЗ)",
        "🌐 skillwharf.ru — интерактивное демо 12 отраслей и форма Design Partner",
        "🚀 От пилота до публичного GA: Docker по умолчанию, Enterprise-изоляция в K8s",
    ],
    "https://skillwharf.ru",
)

# Слайд 2 — проблема.
create_slide(
    "Проблема: ИИ-агенты — это «чёрный ящик»",
    "Бизнес хочет автоматизации, но боится давать доступы нейросетям:",
    [
        "❌ Опасные действия (удаление баз, утечка данных)",
        "❌ Галлюцинации и непроверенные ответы",
        "❌ Скрытые расходы: токены списываются даже при ошибке",
    ],
)

# Слайд 3 — решение и покрытие треков.
create_slide(
    "Решение: Управляемый AI-Офис",
    "12 готовых бизнес-треков (A–L) с автономностью без потери контроля:",
    [
        "🛡️ Human-in-the-Loop: одобрение критичных действий до выполнения",
        "🧩 A–L: от ПВЗ, HR и Контента до Опта (K) и Производства (L)",
        "🔗 Интеграции Битрикс24 и МойСклад CRM/ERP + Ozon/WB, Telegram, Google Workspace",
        "📊 Долговременная память и аудит каждого шага в append-only Ledger",
    ],
)

# Слайд 4 — экосистема и монетизация.
create_slide(
    "Экосистема и монетизация",
    "Публичный Marketplace навыков и прозрачная экономика:",
    [
        "🔐 Маркетплейс навыков с криптографической подписью Ed25519 и проверкой при установке",
        "💼 Подписки Free / Pro / Team / Enterprise для разных масштабов команд",
        "💳 Pay-per-Call и Pay-per-Outcome с эскроу ЮKassa (деньги замораживаются до результата)",
        "🤝 Revenue Share 85/15: автору 85%, платформе 15% — сплит в BAL и Ledger",
    ],
)

# Слайд 5 — enterprise-безопасность.
create_slide(
    "Enterprise-безопасность",
    "Изоляция и защита секретов на всех уровнях:",
    [
        "🐳 Изоляция Docker по умолчанию; Firecracker microVM (KVM) и Kubernetes gVisor без /dev/kvm",
        "🌐 SNI/Host Egress-прокси с защитой от DNS rebinding и SSRF",
        "🔑 Шифрование ключей с версиями keyId и ротацией (v2 envelope, previous keys)",
        "🗄️ Зашифрованные offsite-бэкапы: AES-256-CBC + SHA-256, изолированный restore-drill",
    ],
)

# Слайд 6 — Control Plane v2 и масштабируемость.
create_slide(
    "Control Plane v2 и масштабируемая память",
    "Управляйте промптами, тарифами и ростом базы знаний без перезапуска:",
    [
        "🧪 A/B-тестирование промптов: доли трафика, сравнение latency/cost, повышение версии B",
        "💰 Per-model тарифы LLM (input/output) в Ledger и Prometheus, метрики без взрыва кардинальности",
        "🧠 Память с метаданными (kind/source/updatedAt); pgvector по умолчанию и Qdrant при росте",
        "📈 OIDC-SSO, Tempo-трейсы, Grafana и алерты — наблюдаемость из коробки",
    ],
    "Готовы обсудить? Демо 12 отраслей: https://skillwharf.ru",
)

prs.save(OUTPUT)
print(f"Файл {OUTPUT.name} успешно создан: {OUTPUT}")
