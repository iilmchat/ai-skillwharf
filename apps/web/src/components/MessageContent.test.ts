import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from './MessageContent';

describe('MessageContent', () => {
  it('рендерит превью Markdown-картинки ссылкой в полном размере', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        content: 'Готово: ![кот](https://cdn.example.com/cat.png)',
        isStreaming: false,
        imageAltFallback: 'Изображение от агента',
      }),
    );

    expect(html).toContain('<img');
    expect(html).toContain('src="https://cdn.example.com/cat.png"');
    expect(html).toContain('href="https://cdn.example.com/cat.png"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('alt="кот"');
  });

  it('подставляет fallback-alt для голого URL', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        content: 'https://cdn.example.com/result.png',
        isStreaming: false,
        imageAltFallback: 'Изображение от агента',
      }),
    );

    expect(html).toContain('alt="Изображение от агента"');
  });

  it('обычный текст оставляет текстом', () => {
    const html = renderToStaticMarkup(
      createElement(MessageContent, {
        content: 'Никаких картинок',
        isStreaming: false,
        imageAltFallback: 'Изображение от агента',
      }),
    );

    expect(html).toContain('Никаких картинок');
    expect(html).not.toContain('<img');
  });
});
