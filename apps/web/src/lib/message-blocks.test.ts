import { describe, expect, it } from 'vitest';
import { parseMessageBlocks } from './message-blocks';

function fence(language: string, body: string): string {
  return ['```' + language, body, '```'].join('\n');
}

describe('parseMessageBlocks', () => {
  it('обычный текст остаётся одним текстовым блоком', () => {
    expect(parseMessageBlocks('Готово.\n\nПроверьте отчёт.')).toEqual([
      { type: 'text', text: 'Готово.\n\nПроверьте отчёт.' },
    ]);
  });

  it('пустой ответ даёт пустой текстовый блок', () => {
    expect(parseMessageBlocks('')).toEqual([{ type: 'text', text: '' }]);
  });

  it('блок кода определяет язык', () => {
    expect(
      parseMessageBlocks(`До\n${fence('ts', 'const a = 1;')}\nПосле`),
    ).toEqual([
      { type: 'text', text: 'До' },
      { type: 'code', language: 'ts', code: 'const a = 1;' },
      { type: 'text', text: 'После' },
    ]);
  });

  it('незакрытый fence (ответ стримится) остаётся текстом', () => {
    const blocks = parseMessageBlocks('Вот код:\n```ts\nconst a =');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
  });

  it('таблицу в pipe-стиле превращает в блок table', () => {
    const content = [
      'Итоги:',
      '| Позиция | Сумма |',
      '| :--- | ---: |',
      '| Логистика | 1200 |',
      '| Комиссия | 300 |',
    ].join('\n');

    expect(parseMessageBlocks(content)).toEqual([
      { type: 'text', text: 'Итоги:' },
      {
        type: 'table',
        table: {
          columns: ['Позиция', 'Сумма'],
          rows: [
            ['Логистика', '1200'],
            ['Комиссия', '300'],
          ],
        },
      },
    ]);
  });

  it('выравнивает строки таблицы по ширине заголовка', () => {
    const content = [
      '| A | B |',
      '| --- | --- |',
      '| 1 |',
      '| 1 | 2 | 3 |',
    ].join('\n');

    expect(parseMessageBlocks(content)).toEqual([
      {
        type: 'table',
        table: {
          columns: ['A', 'B'],
          rows: [
            ['1', ''],
            ['1', '2'],
          ],
        },
      },
    ]);
  });

  it('текст с одной чертой не считается таблицей', () => {
    const content = ['Ошибка | Причина', 'Что-то пошло не так'].join('\n');
    const blocks = parseMessageBlocks(content);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
  });

  it('JSON резюме в fence показывает карточки, а не код', () => {
    const resume = JSON.stringify({
      name: 'Анна',
      skills: ['React'],
      experience: [{ company: 'Яндекс' }],
    });
    const blocks = parseMessageBlocks(fence('json', resume));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('resume');
  });

  it('произвольный JSON остаётся блоком кода', () => {
    const blocks = parseMessageBlocks(fence('json', '{"total": 2}'));

    expect(blocks).toEqual([
      { type: 'code', language: 'json', code: '{"total": 2}' },
    ]);
  });

  it('резюме целиком в ответе (без fence) тоже распознаётся', () => {
    const blocks = parseMessageBlocks(
      JSON.stringify({
        candidate: { name: 'Иван', skills: [{ name: 'Go', years: 4 }] },
      }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('resume');
  });

  it('таблица внутри блока кода не разбирается как таблица', () => {
    const blocks = parseMessageBlocks(
      fence('md', ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')),
    );

    expect(blocks).toEqual([
      {
        type: 'code',
        language: 'md',
        code: '| A | B |\n| --- | --- |\n| 1 | 2 |',
      },
    ]);
  });
});
