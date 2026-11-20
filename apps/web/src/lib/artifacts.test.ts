import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  ARTIFACT_REFINEMENT_ENDPOINT,
  artifactFileName,
  artifactItemSchema,
  artifactToCsv,
  artifactToMarkdown,
  artifactToPrintHtml,
  executionStepSchema,
  parseArtifactTable,
  refineArtifact,
} from './artifacts';

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock('./api', () => ({
  api: { post: postMock },
}));

const ARTIFACT = {
  id: 'art-1',
  type: 'document',
  title: 'Договор',
  content: '# Раздел\n\nТекст **договора**.',
} as const;

const STEP = {
  stepIndex: 0,
  name: 'Поиск регламента',
  toolName: 'rag_search',
  durationMs: 1250,
  status: 'completed',
  costRub: 0.35,
};

const PRINT_LABELS = {
  lang: 'ru',
  platform: 'SkillWharf',
  generatedAt: '20.11.2026, 11:00',
  typeLabel: 'Документ',
};

describe('artifactItemSchema', () => {
  it('принимает документ, таблицу и код', () => {
    expect(artifactItemSchema.parse(ARTIFACT)).toEqual(ARTIFACT);
    expect(
      artifactItemSchema.parse({
        id: 'art-2',
        type: 'table',
        title: 'Таблица',
        content: '| A | B |\n| --- | --- |\n| 1 | 2 |',
      }).type,
    ).toBe('table');
    expect(
      artifactItemSchema.parse({
        id: 'art-3',
        type: 'code',
        title: 'Скрипт',
        language: 'ts',
        content: 'const a = 1;',
      }).language,
    ).toBe('ts');
  });

  it('отклоняет пустые поля, неизвестный тип и лишние поля', () => {
    expect(artifactItemSchema.safeParse({ ...ARTIFACT, id: '' }).success).toBe(false);
    expect(
      artifactItemSchema.safeParse({ ...ARTIFACT, type: 'image' }).success,
    ).toBe(false);
    expect(
      artifactItemSchema.safeParse({ ...ARTIFACT, secret: 'x' }).success,
    ).toBe(false);
  });
});

describe('executionStepSchema', () => {
  it('принимает все статусы и необязательные поля', () => {
    expect(executionStepSchema.parse(STEP)).toEqual(STEP);
    expect(
      executionStepSchema.parse({
        stepIndex: 1,
        name: 'Ожидание',
        durationMs: 0,
        status: 'hitl_paused',
      }).costRub,
    ).toBeUndefined();
    expect(
      executionStepSchema.parse({
        stepIndex: 2,
        name: 'Ошибка',
        durationMs: 10,
        status: 'failed',
      }).status,
    ).toBe('failed');
  });

  it('отклоняет неверные значения', () => {
    expect(executionStepSchema.safeParse({ ...STEP, durationMs: -1 }).success).toBe(false);
    expect(executionStepSchema.safeParse({ ...STEP, costRub: -0.1 }).success).toBe(false);
    expect(executionStepSchema.safeParse({ ...STEP, status: 'running' }).success).toBe(false);
    expect(executionStepSchema.safeParse({ ...STEP, stepIndex: 1.5 }).success).toBe(false);
    expect(executionStepSchema.safeParse({ ...STEP, extra: true }).success).toBe(false);
  });
});

describe('parseArtifactTable', () => {
  it('читает Markdown-таблицу', () => {
    expect(
      parseArtifactTable('| Название | Цена |\n| --- | --- |\n| Товар | 10 |'),
    ).toEqual({ columns: ['Название', 'Цена'], rows: [['Товар', '10']] });
  });

  it('читает CSV с запятой и кавычками', () => {
    expect(parseArtifactTable('Name,Value\n"Товар, А",10')).toEqual({
      columns: ['Name', 'Value'],
      rows: [['Товар, А', '10']],
    });
  });

  it('читает CSV с точкой с запятой', () => {
    expect(parseArtifactTable('Название;Цена\nТовар;10')).toEqual({
      columns: ['Название', 'Цена'],
      rows: [['Товар', '10']],
    });
  });

  it('возвращает null для обычного текста', () => {
    expect(parseArtifactTable('Просто абзац')).toBeNull();
  });
});

describe('экспорт артефактов', () => {
  it('форматирует документ как Markdown с заголовком', () => {
    expect(artifactToMarkdown(ARTIFACT)).toBe(
      '# Договор\n\n# Раздел\n\nТекст **договора**.\n',
    );
  });

  it('оборачивает код в fence с языком', () => {
    expect(
      artifactToMarkdown({
        id: 'art-3',
        type: 'code',
        title: 'Скрипт',
        language: 'ts',
        content: 'const a = 1;',
      }),
    ).toBe('# Скрипт\n\n```ts\nconst a = 1;\n```\n');
  });

  it('экспортирует таблицу в CSV с экранированием', () => {
    const table = {
      id: 'art-2',
      type: 'table',
      title: 'Таблица',
      content: '| A | B |\n| --- | --- |\n| "x", y | 2 |',
    } as const;

    expect(artifactToCsv(table)).toBe('A,B\r\n"""x"", y",2\r\n');
  });

  it('не даёт экспортировать в CSV не-таблицу', () => {
    expect(() => artifactToCsv(ARTIFACT)).toThrow();
  });

  it('строит печатный HTML с реквизитами и экранирует текст', () => {
    const html = artifactToPrintHtml(
      { ...ARTIFACT, content: '<script>x</script>\n\n**Важно**' },
      PRINT_LABELS,
    );

    expect(html).toContain('<title>Договор</title>');
    expect(html).toContain('SkillWharf · Документ');
    expect(html).toContain('20.11.2026, 11:00');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>Важно</strong>');
    expect(html).toContain('@page { size: A4');
  });

  it('печатает таблицу как HTML-таблицу, код — как pre', () => {
    expect(
      artifactToPrintHtml(
        {
          id: 'art-2',
          type: 'table',
          title: 'Таблица',
          content: '| A | B |\n| --- | --- |\n| 1 | 2 |',
        },
        PRINT_LABELS,
      ),
    ).toContain('<table><thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(
      artifactToPrintHtml(
        {
          id: 'art-3',
          type: 'code',
          title: 'Скрипт',
          language: 'ts',
          content: 'const a = 1;',
        },
        PRINT_LABELS,
      ),
    ).toContain('<pre><code class="language-ts">const a = 1;</code></pre>');
  });

  it('формирует безопасное имя файла', () => {
    expect(artifactFileName(ARTIFACT, 'md')).toBe('Договор.md');
    expect(artifactFileName({ ...ARTIFACT, title: 'a/b:c *?' }, 'doc')).toBe(
      'a_b_c__.doc',
    );
    expect(artifactFileName({ ...ARTIFACT, title: '   ' }, 'csv')).toBe(
      'artifact.csv',
    );
  });
});

describe('refineArtifact', () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  const REQUEST = {
    artifactType: 'document',
    title: 'Договор',
    fullContent: 'Раздел 1. Текст.',
    selectedText: 'Текст.',
    instruction: 'Сделать строже юридически',
  } as const;

  it('отправляет POST и возвращает валидированный ответ', async () => {
    postMock.mockResolvedValueOnce({
      data: { updatedContent: 'Раздел 1. Положение.', summary: 'Правка внесена' },
    });

    await expect(refineArtifact(REQUEST)).resolves.toEqual({
      updatedContent: 'Раздел 1. Положение.',
      summary: 'Правка внесена',
    });
    expect(postMock).toHaveBeenCalledWith(ARTIFACT_REFINEMENT_ENDPOINT, REQUEST);
  });

  it('не отправляет запрос с фрагментом вне содержимого', async () => {
    await expect(
      refineArtifact({ ...REQUEST, selectedText: 'нет в тексте' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('отбрасывает невалидный ответ API', async () => {
    postMock.mockResolvedValueOnce({ data: { updatedContent: '' } });

    await expect(refineArtifact(REQUEST)).rejects.toBeInstanceOf(ZodError);
  });
});

describe('downloadTextFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('скачивает Blob через временную ссылку и освобождает URL', async () => {
    const { downloadTextFile } = await import('./artifacts');
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    };
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:test');
    const revokeObjectURL = vi.fn<(url: string) => void>();
    const appendChild = vi.fn();

    vi.stubGlobal('document', {
      createElement: vi.fn(() => link),
      body: { appendChild },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.stubGlobal('window', {
      setTimeout: (callback: () => void) => {
        callback();
      },
    });

    downloadTextFile('file.md', 'content', 'text/markdown');

    expect(link.download).toBe('file.md');
    expect(link.href).toBe('blob:test');
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');

    const blob = createObjectURL.mock.calls[0]?.[0];

    expect(blob).toBeInstanceOf(Blob);
    await expect(blob?.text()).resolves.toBe('content');
  });
});



