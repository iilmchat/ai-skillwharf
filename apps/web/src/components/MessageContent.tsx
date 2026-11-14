import { useMemo } from 'react';
import { splitMessageContent } from '../lib/message-images';
import { parseMessageBlocks } from '../lib/message-blocks';
import { MessageCodeBlock } from './MessageCodeBlock';
import { ResultTable } from './ResultTable';
import { ResumeCards, type ResumeLabels } from './ResumeCards';

function StreamingCursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-1 translate-y-0.5 animate-pulse rounded-sm bg-current align-baseline"
    />
  );
}

/** Подписи блоков ответа; страница передаёт их из i18n. */
export interface MessageContentLabels {
  table: string;
  code: string;
  resume: ResumeLabels;
}

/**
 * Текст с превью картинок.
 *
 * Картинка оборачивается в ссылку `target="_blank"`, поэтому её можно открыть
 * в полном размере; сама ссылка уже прошла проверку схемы в парсере.
 */
function TextWithImages({
  text,
  isStreaming,
  imageAltFallback,
}: {
  text: string;
  isStreaming: boolean;
  imageAltFallback: string;
}) {
  const segments = useMemo(() => splitMessageContent(text), [text]);
  const hasImages = segments.some((segment) => segment.type === 'image');

  if (!hasImages) {
    return (
      <p className="whitespace-pre-wrap break-words">
        {text}
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

        const alt =
          segment.image.alt.trim() === ''
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

/**
 * Ответ агента: текст, картинки, блоки кода, таблицы и карточки резюме.
 *
 * Разметка разбирается `parseMessageBlocks`; неизвестные конструкции
 * остаются текстом, поэтому ответ не может подставить произвольный HTML.
 */
export function MessageContent({
  content,
  isStreaming,
  imageAltFallback,
  labels,
}: {
  content: string;
  isStreaming: boolean;
  imageAltFallback: string;
  labels: MessageContentLabels;
}) {
  const blocks = useMemo(() => parseMessageBlocks(content), [content]);

  return (
    <div className="space-y-3">
      {blocks.map((block, index) => {
        const isLast = index === blocks.length - 1;
        const showCursor = isStreaming && isLast;

        if (block.type === 'text') {
          return (
            <TextWithImages
              key={`text-${index}`}
              text={block.text}
              isStreaming={showCursor}
              imageAltFallback={imageAltFallback}
            />
          );
        }

        if (block.type === 'code') {
          return (
            <div key={`code-${index}`}>
              <MessageCodeBlock
                language={block.language}
                code={block.code}
                label={labels.code}
              />
              {showCursor && <StreamingCursor />}
            </div>
          );
        }

        if (block.type === 'table') {
          return (
            <div key={`table-${index}`}>
              <ResultTable table={block.table} label={labels.table} />
              {showCursor && <StreamingCursor />}
            </div>
          );
        }

        return (
          <div key={`resume-${index}`}>
            <ResumeCards resume={block.resume} labels={labels.resume} />
            {showCursor && <StreamingCursor />}
          </div>
        );
      })}
    </div>
  );
}
