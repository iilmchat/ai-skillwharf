"""Smoke-тест документов внутри sandbox-образа.

Запускается из scripts/test-documents.sh под теми же ограничениями, что и
навыки: read-only rootfs, uid 65534, tmpfs /tmp, без сети, 128 МБ памяти.

Проверяет:
  * наличие tesseract, pdftotext, pdftoppm и pandoc;
  * языковые пакеты tesseract rus/eng;
  * цепочку PDF -> pdftotext -> pdftoppm -> tesseract;
  * генерацию DOCX через pandoc и валидность ZIP-пакета.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

TMP = Path("/tmp/document-smoke")
PDF_TEXT = "SKILLWHARF OCR TEST"
DOCX_TEXT = "SkillWharf report"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        fail(
            f"{' '.join(command)} завершился с кодом {result.returncode}: "
            f"{result.stderr.strip()[:300]}"
        )

    return result.stdout


def check_commands() -> None:
    for command in ("tesseract", "pdftotext", "pdftoppm", "pandoc"):
        if shutil.which(command) is None:
            fail(f"в образе нет {command}")

    languages = run(["tesseract", "--list-langs"]).split()
    for language in ("rus", "eng"):
        if language not in languages:
            fail(f"в tesseract нет языковых данных {language}")

    print("OK: tesseract, pdftotext, pdftoppm и pandoc доступны (rus+eng)")


def make_pdf(path: Path) -> None:
    """Собирает минимальный PDF с текстом без внешних библиотек."""
    content = f"BT /F1 24 Tf 20 40 Td ({PDF_TEXT}) Tj ET\n".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 120] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length "
        + str(len(content)).encode()
        + b" >>\nstream\n"
        + content
        + b"endstream",
    ]

    payload = bytearray(b"%PDF-1.4\n")
    offsets = [0]

    for index, obj in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"

    xref_offset = len(payload)
    payload += f"xref\n0 {len(objects) + 1}\n".encode()
    payload += b"0000000000 65535 f \n"

    for offset in offsets[1:]:
        payload += f"{offset:010d} 00000 n \n".encode()

    payload += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode()
    path.write_bytes(payload)


def check_pdf_and_ocr() -> None:
    pdf = TMP / "sample.pdf"
    make_pdf(pdf)

    text = run(["pdftotext", str(pdf), "-"])

    if PDF_TEXT not in text:
        fail(f"pdftotext не извлёк '{PDF_TEXT}': {text.strip()[:200]!r}")

    run(["pdftoppm", "-png", "-r", "150", "-singlefile", str(pdf), str(TMP / "sample")])
    image = TMP / "sample.png"

    if not image.is_file():
        fail("pdftoppm не создал PNG")

    recognized = run(["tesseract", str(image), "stdout", "-l", "eng"])

    if "SKILLWHARF" not in recognized.upper():
        fail(f"tesseract не распознал текст: {recognized.strip()[:200]!r}")

    print("OK: PDF -> pdftotext -> pdftoppm -> tesseract")


def check_docx() -> None:
    markdown = TMP / "report.md"
    markdown.write_text(f"# Отчёт\n\n{DOCX_TEXT}\n", encoding="utf-8")
    docx = TMP / "report.docx"

    run(["pandoc", str(markdown), "-o", str(docx)])

    if not docx.is_file():
        fail("pandoc не создал DOCX")

    with zipfile.ZipFile(docx) as archive:
        if "word/document.xml" not in archive.namelist():
            fail("в DOCX нет word/document.xml")

        document = archive.read("word/document.xml")

    if DOCX_TEXT.encode() not in document:
        fail("в DOCX нет ожидаемого текста")

    print("OK: Markdown -> pandoc -> DOCX")


def main() -> None:
    TMP.mkdir(parents=True, exist_ok=True)
    check_commands()
    check_pdf_and_ocr()
    check_docx()
    print("OK: документы в sandbox-образе работают")


if __name__ == "__main__":
    main()
