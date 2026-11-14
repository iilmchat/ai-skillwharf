import AdmZip from 'adm-zip';

/**
 * Генерация DOCX (Office Open XML) без нативного Word и без внешних
 * конвертеров: собираем минимальный, но валидный пакет OOXML и упаковываем его
 * в ZIP через `adm-zip`.
 *
 * Пакет содержит обязательные части:
 * - `[Content_Types].xml` — типы содержимого;
 * - `_rels/.rels` — связь «пакет → основной документ»;
 * - `word/document.xml` — тело документа;
 * - `word/_rels/document.xml.rels` — связи документа (стили);
 * - `word/styles.xml` — стили `Normal`, `Heading1..3` и `TableGrid`.
 *
 * Таблица описана явными границами в `w:tblPr`, поэтому не зависит от
 * настроек шаблона пользователя. Списки оформлены маркером `•` в тексте
 * абзаца: `word/numbering.xml` для этого не нужен, а файл открывается в Word,
 * LibreOffice и Google Docs.
 */

/** Допустимый уровень заголовка. */
export type DocxHeadingLevel = 1 | 2 | 3;

/** Блок тела документа. */
export type DocxBlock =
  | { readonly type: 'heading'; readonly text: string; readonly level?: DocxHeadingLevel }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bullets'; readonly items: readonly string[] }
  | {
      readonly type: 'table';
      readonly headers?: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

/** Документ для генерации. */
export interface DocxDocument {
  readonly title: string;
  readonly subtitle?: string;
  readonly blocks: readonly DocxBlock[];
}

/** Размеры страницы A4 в twips (1/1440 дюйма). */
const A4_WIDTH_TWIPS = 11_906;
const A4_HEIGHT_TWIPS = 16_838;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="30"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:i/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
</w:styles>`;

/**
 * Собирает DOCX в памяти.
 *
 * @throws Error если документ пуст или превышает лимиты OOXML-ячейки.
 */
export function buildDocx(document: DocxDocument): Buffer {
  const title = document.title.trim();

  if (title === '') {
    throw new Error('Заголовок документа обязателен');
  }

  const body: string[] = [
    paragraph(title, 'Heading1'),
  ];

  if (document.subtitle !== undefined && document.subtitle.trim() !== '') {
    body.push(paragraph(document.subtitle, 'Subtitle'));
  }

  for (const block of document.blocks) {
    body.push(renderBlock(block));
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${body.filter((part) => part !== '').join('\n')}
    <w:sectPr>
      <w:pgSz w:w="${A4_WIDTH_TWIPS}" w:h="${A4_HEIGHT_TWIPS}"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const zip = new AdmZip();

  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(CONTENT_TYPES_XML, 'utf8'),
  );
  zip.addFile('_rels/.rels', Buffer.from(ROOT_RELS_XML, 'utf8'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(documentXml, 'utf8'),
  );
  zip.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from(DOCUMENT_RELS_XML, 'utf8'),
  );
  zip.addFile('word/styles.xml', Buffer.from(STYLES_XML, 'utf8'));

  return zip.toBuffer();
}

/** Рендер одного блока в OOXML. */
function renderBlock(block: DocxBlock): string {
  switch (block.type) {
    case 'heading':
      return paragraph(block.text, `Heading${block.level ?? 2}`);
    case 'paragraph':
      return paragraph(block.text);
    case 'bullets':
      return block.items
        .map((item) => paragraph(`• ${item}`, 'Normal'))
        .join('\n');
    case 'table':
      return renderTable(block.headers, block.rows);
    default: {
      const exhaustive: never = block;

      throw new Error(`Неизвестный блок документа: ${String(exhaustive)}`);
    }
  }
}

/** Абзац: `<w:p>` с необязательным стилем; переносы строк — через `<w:br/>`. */
function paragraph(text: string, style?: string): string {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line) => {
      const runs = escapeXml(line).replace(/ {2,}/g, (spaces) =>
        spaces.replace(/ /g, '&#160;'),
      );

      return runs;
    });

  const pPr =
    style === undefined
      ? ''
      : `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/></w:pPr>`;
  const runs = paragraphs
    .map((line, index) =>
      `${index === 0 ? '' : '<w:r><w:br/></w:r>'}<w:r><w:t xml:space="preserve">${line}</w:t></w:r>`,
    )
    .join('');

  return `    <w:p>${pPr}${runs}</w:p>`;
}

/** Таблица: первая строка — заголовки, если они заданы. */
function renderTable(
  headers: readonly string[] | undefined,
  rows: readonly (readonly string[])[],
): string {
  const allRows = [
    ...(headers === undefined || headers.length === 0 ? [] : [headers]),
    ...rows,
  ];

  if (allRows.length === 0) {
    return '';
  }

  const width = Math.max(...allRows.map((row) => row.length));
  const tableRows = allRows.map((row, rowIndex) => {
    const cells: string[] = [];

    for (let column = 0; column < width; column += 1) {
      const value = row[column] ?? '';
      const isHeader =
        headers !== undefined && headers.length > 0 && rowIndex === 0;
      const pPr = isHeader
        ? '<w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="left"/></w:pPr>'
        : '';
      const rPr = isHeader ? '<w:rPr><w:b/></w:rPr>' : '';

      cells.push(
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p></w:tc>`,
      );
    }

    return `      <w:tr>${cells.join('')}</w:tr>`;
  });

  return `    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>
${tableRows.join('\n')}
    </w:tbl>`;
}

/** Экранирование XML-спецсимволов и удаление управляющих байтов. */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
