import { z } from 'zod';

/** Картинка, которую агент вернул прямо в тексте ответа. */
export interface MessageImage {
  url: string;
  alt: string;
}

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'image'; image: MessageImage };

const imageUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;

      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  },
  { message: 'ожидается http(s) URL изображения' },
);

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s<>"']*)?$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_IMAGE = /https?:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s<>"']*)?/gi;

function safeImageUrl(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?]+$/, '');
  const parsed = imageUrlSchema.safeParse(trimmed);

  return parsed.success ? parsed.data : null;
}

function pushText(segments: MessageSegment[], text: string): void {
  if (text !== '') {
    segments.push({ type: 'text', text });
  }
}

function pushImage(
  segments: MessageSegment[],
  rawUrl: string,
  alt: string,
): void {
  const url = safeImageUrl(rawUrl);

  if (url === null) {
    pushText(segments, `![${alt}](${rawUrl})`);
    return;
  }

  segments.push({ type: 'image', image: { url, alt } });
}

const IMAGE_FIELD_KEYS = new Set([
  'imageUrl',
  'image_url',
  'image',
  'images',
  'imageUrls',
  'output',
]);

function collectJsonImages(value: unknown, depth: number): MessageImage[] {
  if (depth > 5) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectJsonImages(item, depth + 1));
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  const images: MessageImage[] = [];

  for (const [key, nested] of Object.entries(value)) {
    if (IMAGE_FIELD_KEYS.has(key)) {
      if (typeof nested === 'string') {
        const url = safeImageUrl(nested);

        if (url !== null) {
          images.push({ url, alt: '' });
        }

        continue;
      }

      if (Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === 'string') {
            const url = safeImageUrl(item);

            if (url !== null) {
              images.push({ url, alt: '' });
            }
          } else {
            images.push(...collectJsonImages(item, depth + 1));
          }
        }

        continue;
      }

      images.push(...collectJsonImages(nested, depth + 1));
      continue;
    }

    if (typeof nested === 'object' && nested !== null) {
      images.push(...collectJsonImages(nested, depth + 1));
    }
  }

  return images;
}

/**
 * TTAPI/инструмент `generate_image` может вернуть JSON с `imageUrl`.
 * Если весь ответ — такой JSON, показываем только изображения, без сырого
 * технического JSON в пузыре чата.
 */
function parseJsonMessageImages(content: string): MessageImage[] {
  const trimmed = content.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    return collectJsonImages(parsed, 0);
  } catch {
    return [];
  }
}

function splitBareImages(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(BARE_IMAGE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const url = safeImageUrl(raw);

    if (url === null) {
      continue;
    }

    // Регэксп может захватить завершающую точку/запятую — оставляем её тексту.
    const matchedLength = raw.replace(/[.,;:!?]+$/, '').length;

    if (index > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, index) });
    }

    segments.push({ type: 'image', image: { url, alt: '' } });
    cursor = index + matchedLength;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }

  return segments;
}

/**
 * Разбирает ответ ассистента на текст и изображения.
 *
 * Поддерживаются Markdown `![alt](https://...png)` и «голые» http(s)-ссылки
 * с расширением картинки. Валидация URL отсекает `javascript:`/`data:` и
 * другие схемы, чтобы текст агента не мог подставить произвольный ресурс.
 */
export function splitMessageContent(content: string): MessageSegment[] {
  const jsonImages = parseJsonMessageImages(content);

  if (jsonImages.length > 0) {
    return jsonImages.map((image) => ({ type: 'image', image }));
  }

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(MARKDOWN_IMAGE)) {
    const raw = match[0];
    const alt = match[1] ?? '';
    const url = match[2] ?? '';
    const index = match.index ?? 0;

    if (index > cursor) {
      segments.push(...splitBareImages(content.slice(cursor, index)));
    }

    pushImage(segments, url, alt);
    cursor = index + raw.length;
  }

  if (cursor < content.length) {
    segments.push(...splitBareImages(content.slice(cursor)));
  }

  return segments;
}

/** Есть ли в ответе хотя бы одна картинка. */
export function hasMessageImages(content: string): boolean {
  return splitMessageContent(content).some((segment) => segment.type === 'image');
}

/** Проверка, что ссылка действительно похожа на изображение. */
export function isMessageImageUrl(value: string): boolean {
  return IMAGE_EXTENSION.test(value) && safeImageUrl(value) !== null;
}
