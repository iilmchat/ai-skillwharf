from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

def create_slide(prs, title, subtitle, bullets, slide_num):
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    
    # Title
    title_shape = slide.shapes.title
    title_shape.text = title
    title_shape.text_frame.paragraphs[0].font.size = Pt(44)
    title_shape.text_frame.paragraphs[0].font.bold = True
    title_shape.text_frame.paragraphs[0].font.color.rgb = RGBColor(107, 56, 212) # SkillWharf Purple
    
    # Subtitle & Bullets
    tf = slide.placeholders[1].text_frame
    tf.text = subtitle
    tf.paragraphs[0].font.size = Pt(24)
    tf.paragraphs[0].font.bold = True
    
    for bullet in bullets:
        p = tf.add_paragraph()
        p.text = bullet
        p.font.size = Pt(20)
        p.space_before = Pt(20)
        
    return slide

# Слайд 1
create_slide(prs, 
    "Проблема: ИИ-агенты — это «черный ящик»", 
    "Бизнес хочет автоматизации, но боится давать доступы нейросетям:",
    ["❌ Опасные действия (удаление баз, слив данных)", 
     "❌ Галлюцинации (уверенная чушь)", 
     "❌ Скрытые расходы (оплата за токены даже при ошибке)"], 1)

# Слайд 2
create_slide(prs, 
    "Решение: Управляемый AI-Офис", 
    "SkillWharf дает автономность без потери контроля:",
    ["🛡️ Human-in-the-Loop: кнопка «Одобрить» для важных шагов", 
     "🔒 Self-Hosted & Sandbox: безопасность данных (152-ФЗ)", 
     "📊 12 треков: Опт, Производство, E-commerce, HR и др."], 2)

# Слайд 3
create_slide(prs, 
    "Модель: Pay-per-Outcome (Оплата за результат)", 
    "Вы платите только тогда, когда агент справился с задачей:",
    ["1️⃣ Авторизация: Деньги замораживаются (Escrow)", 
     "2️⃣ Выполнение: Агент делает работу, вы проверяете", 
     "3️⃣ Списание: Успех -> оплата. Ошибка -> возврат средств."], 3)

prs.save('SkillWharf_Pitch.pptx')
print("Файл SkillWharf_Pitch.pptx успешно создан!")