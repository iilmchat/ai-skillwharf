import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent, type MessageContentLabels } from './MessageContent';

const LABELS: MessageContentLabels = {
  table: 'Таблица из ответа агента',
  code: 'Блок кода из ответа агента',
  resume: {
    resume: 'Кандидат',
    summary: 'О кандидате',
    skills: 'Навыки',
    experience: 'Опыт',
    education: 'Образование',
    verdict: 'Вердикт',
    match: 'Совпадение',
    years: 'лет',
    score: 'Балл',
  },
};

function renderContent(content: string): string {
  return renderToStaticMarkup(
    createElement(MessageContent, {
      content,
      isStreaming: false,
      imageAltFallback: 'Изображение от агента',
      labels: LABELS,
    }),
  );
}

describe('MessageContent', () => {
  it('рендерит превью Markdown-картинки ссылкой в полном размере', () => {
    const html = renderContent(
      'Готово: ![кот](https://cdn.example.com/cat.png)',
    );

    expect(html).toContain('<img');
    expect(html).toContain('src="https://cdn.example.com/cat.png"');
    expect(html).toContain('href="https://cdn.example.com/cat.png"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('alt="кот"');
  });

  it('подставляет fallback-alt для голого URL', () => {
    const html = renderContent('https://cdn.example.com/result.png');

    expect(html).toContain('alt="Изображение от агента"');
  });

  it('обычный текст оставляет текстом', () => {
    const html = renderContent('Никаких картинок');

    expect(html).toContain('Никаких картинок');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<table');
  });

  it('таблицу агента рендерит как <table> с заголовками и ячейками', () => {
    const html = renderContent(
      [
        'Итоги разбора:',
        '| Позиция | Сумма |',
        '| --- | --- |',
        '| Логистика | 1200 |',
      ].join('\n'),
    );

    expect(html).toContain('<table');
    expect(html).toContain('Таблица из ответа агента');
    expect(html).toContain('scope="col"');
    expect(html).toContain('Логистика');
    expect(html).toContain('1200');
    expect(html).toContain('Итоги разбора:');
  });

  it('блок кода рендерит с подписью языка и экранирует разметку', () => {
    const html = renderContent(
      ['```ts', 'const a = "<script>";', '```'].join('\n'),
    );

    expect(html).toContain('<pre');
    expect(html).toContain('ts');
    expect(html).toContain('const a =');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('JSON резюме показывает карточками навыков и опыта', () => {
    const html = renderContent(
      [
        '```json',
        JSON.stringify({
          name: 'Анна Петрова',
          score: 87,
          skills: ['React', { name: 'TypeScript', years: 6 }],
          experience: [
            {
              company: 'Яндекс',
              position: 'Frontend Lead',
              period: '2021—2025',
            },
          ],
        }),
        '```',
      ].join('\n'),
    );

    expect(html).toContain('Анна Петрова');
    expect(html).toContain('React');
    expect(html).toContain('TypeScript');
    expect(html).toContain('Яндекс');
    expect(html).toContain('Frontend Lead');
    expect(html).toContain('Опыт');
    expect(html).not.toContain('<pre');
  });
});
