import { describe, expect, it } from 'vitest';
import { parseArtifacts } from './artifact-parser.js';

describe('parseArtifacts (UX-37.1/37.2)', () => {
  it('извлекает тег skillwharf-artifact и убирает его из ответа', () => {
    const reply = [
      'Вот отчёт:',
      '<skillwharf-artifact type="document" title="Договор" language="markdown">',
      '# Договор №42',
      'Условия поставки.',
      '</skillwharf-artifact>',
      'Готово.',
    ].join('\n');

    const parsed = parseArtifacts(reply);

    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]).toMatchObject({
      id: 'art-1',
      type: 'document',
      title: 'Договор',
      language: 'markdown',
      content: '# Договор №42\nУсловия поставки.',
    });
    expect(parsed.cleanText).toContain('Вот отчёт:');
    expect(parsed.cleanText).toContain('Готово.');
    expect(parsed.cleanText).not.toContain('skillwharf-artifact');
  });

  it('поддерживает type=code и type=table', () => {
    const reply = [
      '<skillwharf-artifact type="code" title="Схема" language="yaml">',
      'version: "1.0"',
      '</skillwharf-artifact>',
      '<skillwharf-artifact type="table" title="Итоги">',
      'a,b\n1,2',
      '</skillwharf-artifact>',
    ].join('\n');

    const { artifacts } = parseArtifacts(reply);

    expect(artifacts.map((item) => [item.type, item.title])).toEqual([
      ['code', 'Схема'],
      ['table', 'Итоги'],
    ]);
    expect(artifacts[0]?.language).toBe('yaml');
  });

  it('распознаёт fenced-блок с заголовком title', () => {
    const reply = [
      'Таблица ниже:',
      '```csv title="Результаты"',
      'name,value',
      'alpha,10',
      '```',
    ].join('\n');

    const { artifacts, cleanText } = parseArtifacts(reply);

    expect(artifacts).toEqual([
      expect.objectContaining({
        type: 'table',
        title: 'Результаты',
        content: 'name,value\nalpha,10',
      }),
    ]);
    expect(cleanText).toContain('```csv');
  });

  it('возвращает пустой список для обычного текста', () => {
    const parsed = parseArtifacts('Обычный ответ без артефактов.');

    expect(parsed.artifacts).toEqual([]);
    expect(parsed.cleanText).toBe('Обычный ответ без артефактов.');
  });
});
