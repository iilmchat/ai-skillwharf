import { describe, expect, it } from 'vitest';
import {
  hasMessageImages,
  isMessageImageUrl,
  splitMessageContent,
} from './message-images';

describe('splitMessageContent', () => {
  it('оставляет обычный текст текстом', () => {
    expect(splitMessageContent('Привет! Чем помочь?')).toEqual([
      { type: 'text', text: 'Привет! Чем помочь?' },
    ]);
    expect(hasMessageImages('Привет! Чем помочь?')).toBe(false);
  });

  it('распознаёт Markdown-картинку и сохраняет alt', () => {
    const segments = splitMessageContent(
      'Готово: ![кот](https://cdn.example.com/cat.png)',
    );

    expect(segments).toEqual([
      { type: 'text', text: 'Готово: ' },
      {
        type: 'image',
        image: {
          url: 'https://cdn.example.com/cat.png',
          alt: 'кот',
        },
      },
    ]);
    expect(hasMessageImages('![кот](https://cdn.example.com/cat.png)')).toBe(
      true,
    );
  });

  it('распознаёт голый URL картинки с query-параметрами', () => {
    const segments = splitMessageContent(
      'Результат: https://cdn.example.com/image.webp?width=1024.',
    );

    expect(segments).toEqual([
      { type: 'text', text: 'Результат: ' },
      {
        type: 'image',
        image: {
          url: 'https://cdn.example.com/image.webp?width=1024',
          alt: '',
        },
      },
      { type: 'text', text: '.' },
    ]);
  });

  it('извлекает imageUrl из JSON TTAPI без расширения файла', () => {
    expect(
      splitMessageContent(
        JSON.stringify({
          taskId: 'task-1',
          imageUrl: 'https://api.ttapi.io/image/task-1',
          status: 'completed',
        }),
      ),
    ).toEqual([
      {
        type: 'image',
        image: { url: 'https://api.ttapi.io/image/task-1', alt: '' },
      },
    ]);

    expect(
      splitMessageContent(
        JSON.stringify({
          data: { imageUrl: 'https://cdn.example.com/result' },
        }),
      ),
    ).toEqual([
      {
        type: 'image',
        image: { url: 'https://cdn.example.com/result', alt: '' },
      },
    ]);
  });

  it('не превращает произвольные ссылки в изображения', () => {
    const text =
      'Документация: https://example.com/docs и https://example.com/page?x=1';

    expect(splitMessageContent(text)).toEqual([{ type: 'text', text }]);
    expect(isMessageImageUrl('https://example.com/docs')).toBe(false);
    expect(isMessageImageUrl('https://cdn.example.com/a.png')).toBe(true);
  });

  it('отклоняет небезопасные схемы и оставляет исходный Markdown текстом', () => {
    const segments = splitMessageContent(
      '![x](javascript:alert(1)) и ![y](data:image/png;base64,abc)',
    );

    expect(segments).toEqual([
      {
        type: 'text',
        text: '![x](javascript:alert(1)) и ![y](data:image/png;base64,abc)',
      },
    ]);
  });

  it('поддерживает несколько картинок и текст между ними', () => {
    const segments = splitMessageContent(
      'Один ![a](https://cdn.example.com/a.jpg) два https://cdn.example.com/b.png',
    );

    expect(segments.map((segment) => segment.type)).toEqual([
      'text',
      'image',
      'text',
      'image',
    ]);
  });
});
