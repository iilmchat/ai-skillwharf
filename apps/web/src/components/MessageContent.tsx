import { useMemo } from 'react';
import { splitMessageContent } from '../lib/message-images';

function StreamingCursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-1 translate-y-0.5 animate-pulse rounded-sm bg-current align-baseline"
    />
  );
}

/**
 * Текст ответа агента с превью картинок.
 *
 * Картинка оборачивается в ссылку `target="_blank"`, поэтому её можно открыть
 * в полном размере; сама ссылка уже прошла проверку схемы в парсере.
 */
export function MessageContent({
  content,
  isStreaming,
  imageAltFallback,
}: {
  content: string;
  isStreaming: boolean;
  imageAltFallback: string;
}) {
  const segments = useMemo(() => splitMessageContent(content), [content]);
  const hasImages = segments.some((segment) => segment.type === 'image');

  if (!hasImages) {
    return (
      <p className="whitespace-pre-wrap break-words">
        {content}
        {isStreaming && <StreamingCursor />}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <p
              key={`text-${index}`}
              className="whitespace-pre-wrap break-words"
            >
              {segment.text}
              {isStreaming && index === segments.length - 1 && (
                <StreamingCursor />
              )}
            </p>
          );
        }

        const alt = segment.image.alt.trim() === ''
          ? imageAltFallback
          : segment.image.alt;

        return (
          <a
            key={`image-${index}`}
            href={segment.image.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={alt}
            title={alt}
            className="block w-fit max-w-full rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <img
              src={segment.image.url}
              alt={alt}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="max-h-80 w-auto max-w-full rounded-xl border border-outline-variant bg-surface-container object-contain"
            />
          </a>
        );
      })}
    </div>
  );
}
