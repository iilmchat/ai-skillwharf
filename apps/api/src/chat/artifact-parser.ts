import { z } from 'zod';
import {
  artifactItemSchema,
  executionStepSchema,
  type ArtifactItem,
} from '../agent/contracts.js';

/** Метаданные сообщения ассистента, сохраняемые в Message.metadataJson. */
export const assistantMetadataSchema = z
  .object({
    artifacts: z.array(artifactItemSchema).optional(),
    executionTrace: z.array(executionStepSchema).optional(),
    cacheHit: z.boolean().optional(),
  })
  .strict();
export type AssistantMetadata = z.infer<typeof assistantMetadataSchema>;

export interface ParsedArtifacts {
  /** Ответ модели без служебных тегов артефактов. */
  readonly cleanText: string;
  readonly artifacts: ArtifactItem[];
}

type ArtifactType = ArtifactItem['type'];

const TAGGED_BLOCK =
  /<skillwharf-artifact\b([^>]*)>([\s\S]*?)<\/skillwharf-artifact>/gi;
const FENCED_BLOCK =
  /```([a-z0-9+#._-]*)[ \t]+title="([^"]+)"[^\n]*\n([\s\S]*?)```/gi;

const CODE_LANGUAGES = new Set([
  'json',
  'yaml',
  'yml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'python',
  'sql',
  'xml',
  'sh',
  'bash',
]);
const TABLE_LANGUAGES = new Set(['csv', 'tsv', 'table']);

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attrs);

  return match?.[1]?.trim() ?? null;
}

function inferType(language: string | undefined): ArtifactType {
  const normalized = (language ?? '').toLowerCase();

  if (CODE_LANGUAGES.has(normalized)) {
    return 'code';
  }

  if (TABLE_LANGUAGES.has(normalized)) {
    return 'table';
  }

  return 'document';
}

function makeArtifact(
  index: number,
  type: ArtifactType,
  title: string,
  content: string,
  language?: string,
): ArtifactItem {
  return artifactItemSchema.parse({
    id: `art-${index + 1}`,
    type,
    title,
    language: language === undefined || language === '' ? undefined : language,
    content: content.replace(/^\n+|\n+$/g, ''),
  });
}

/**
 * Извлекает структурированные артефакты из ответа модели (UX-37.1/37.2).
 *
 * Поддерживаются явные теги `<skillwharf-artifact type="..." title="...">`
 * и fenced-блоки с заголовком `title="..."` в строке открытия.
 */
export function parseArtifacts(text: string): ParsedArtifacts {
  const artifacts: ArtifactItem[] = [];
  let cleanText = text;
  let index = 0;

  cleanText = cleanText.replace(
    TAGGED_BLOCK,
    (_match: string, attrs: string, content: string) => {
      const explicitType = attribute(attrs, 'type');
      const type: ArtifactType =
        explicitType === 'document' ||
        explicitType === 'table' ||
        explicitType === 'code'
          ? explicitType
          : inferType(attribute(attrs, 'language') ?? undefined);
      const title = attribute(attrs, 'title') ?? `Артефакт ${index + 1}`;
      const language = attribute(attrs, 'language') ?? undefined;

      artifacts.push(makeArtifact(index, type, title, content, language));
      index += 1;

      return '';
    },
  );

  cleanText = cleanText.replace(
    FENCED_BLOCK,
    (_match: string, language: string, title: string, content: string) => {
      artifacts.push(
        makeArtifact(index, inferType(language), title, content, language),
      );
      index += 1;

      return _match;
    },
  );

  return {
    cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(),
    artifacts,
  };
}
