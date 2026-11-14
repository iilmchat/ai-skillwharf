import AdmZip from 'adm-zip';

/**
 * Чтение текста из DOCX: распаковка пакета и разбор `word/document.xml`.
 *
 * Абзацы разделяются `\n`, ячейки таблиц — `\t`, чтобы текст можно было
 * передавать в `document-analyzer` и повторно собирать таблицы. Полноценный
 * OOXML-парсер не нужен: извлекаем только текстовые узлы `w:t`.
 */
export function readDocxText(buffer: Buffer): string {
  let zip: AdmZip;

  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error('Файл не является DOCX (не удалось распаковать ZIP)');
  }

  const entry = zip.getEntry('word/document.xml');

  if (entry === null) {
    throw new Error('В DOCX отсутствует word/document.xml');
  }

  const xml = entry.getData().toString('utf8');
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, '\t');

  const text = withBreaks
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/g, '&');

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^\t+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
