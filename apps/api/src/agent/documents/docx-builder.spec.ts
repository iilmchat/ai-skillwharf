import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { buildDocx, escapeXml, type DocxDocument } from './docx-builder.js';

/** Читает часть пакета DOCX как UTF-8. */
function part(buffer: Buffer, name: string): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry(name);

  if (entry === null) {
    throw new Error(`В DOCX нет части ${name}`);
  }

  return entry.getData().toString('utf8');
}

/** Грубая проверка, что XML не содержит неэкранированных `&`. */
function hasUnescapedAmpersand(xml: string): boolean {
  return /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml);
}

const DOC: DocxDocument = {
  title: 'Отчёт по договору',
  subtitle: 'Подготовлено SkillWharf',
  blocks: [
    { type: 'heading', text: 'Раздел 1', level: 2 },
    { type: 'paragraph', text: 'Сумма договора — 150 000 ₽.' },
    { type: 'bullets', items: ['Первый пункт', 'Второй пункт'] },
    {
      type: 'table',
      headers: ['Позиция', 'Количество', 'Цена'],
      rows: [
        ['Работы', '1', '150 000'],
        ['Материалы', '3', '20 000'],
      ],
    },
  ],
};

describe('buildDocx', () => {
  it('собирает пакет OOXML с обязательными частями', () => {
    const zip = new AdmZip(buildDocx(DOC));
    const names = zip.getEntries().map((entry) => entry.entryName).sort();

    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/styles.xml',
    ]);
  });

  it('переносит заголовок, абзацы, список и таблицу в document.xml', () => {
    const xml = part(buildDocx(DOC), 'word/document.xml');

    expect(xml).toContain('<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Отчёт по договору</w:t>');
    expect(xml).toContain('<w:pStyle w:val="Subtitle"/>');
    expect(xml).toContain('Сумма договора — 150 000 ₽.');
    expect(xml).toContain('• Первый пункт');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:tblStyle w:val="TableGrid"/>');
    expect(xml).toContain('<w:t xml:space="preserve">Позиция</w:t>');
    expect(xml).toContain('<w:t xml:space="preserve">Материалы</w:t>');
    expect(xml).toContain('<w:sectPr>');
    expect(hasUnescapedAmpersand(xml)).toBe(false);
  });

  it('экранирует XML-спецсимволы в тексте', () => {
    const xml = part(
      buildDocx({
        title: 'Текст & <разметка>',
        blocks: [{ type: 'paragraph', text: 'a < b & c > d "кавычки"' }],
      }),
      'word/document.xml',
    );

    expect(xml).toContain('Текст &amp; &lt;разметка&gt;');
    expect(xml).toContain('a &lt; b &amp; c &gt; d &quot;кавычки&quot;');
    expect(hasUnescapedAmpersand(xml)).toBe(false);
  });

  it('переносит строки внутри абзаца в w:br', () => {
    const xml = part(
      buildDocx({
        title: 'Заголовок',
        blocks: [{ type: 'paragraph', text: 'Первая строка\nВторая строка' }],
      }),
      'word/document.xml',
    );

    expect(xml).toContain('<w:r><w:br/></w:r>');
    expect(xml).toContain('Вторая строка');
  });

  it('выравнивает строки таблицы по самой широкой строке', () => {
    const xml = part(
      buildDocx({
        title: 'Таблица',
        blocks: [
          {
            type: 'table',
            rows: [
              ['a', 'b', 'c'],
              ['d'],
            ],
          },
        ],
      }),
      'word/document.xml',
    );
    const rows = xml.match(/<w:tr>/g) ?? [];

    expect(rows).toHaveLength(2);
    expect((xml.match(/<w:tc>/g) ?? [])).toHaveLength(6);
  });

  it('требует непустой заголовок', () => {
    expect(() => buildDocx({ title: '   ', blocks: [] })).toThrow(
      /Заголовок документа обязателен/,
    );
  });

  it('escapeXml убирает управляющие символы', () => {
    expect(escapeXml('a\u0001b\u0007c')).toBe('abc');
  });
});
