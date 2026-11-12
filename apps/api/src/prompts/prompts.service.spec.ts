import { NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_SYSTEM_PROMPT } from './default-prompt.js';
import { PromptsService } from './prompts.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  promptTemplate: {
    findUnique: MockFn;
    findFirst: MockFn;
    create: MockFn;
  };
  promptVersion: {
    findFirst: MockFn;
    create: MockFn;
    findMany: MockFn;
  };
}

interface AuditMock {
  record: MockFn;
}

describe('PromptsService', () => {
  let service: PromptsService;
  let prisma: PrismaMock;
  let audit: AuditMock;

  beforeEach(() => {
    prisma = {
      promptTemplate: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      promptVersion: {
        findFirst: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(),
      },
    };
    audit = { record: vi.fn() };

    service = new PromptsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  it('возвращает активную версию системного промпта', async () => {
    prisma.promptTemplate.findFirst.mockResolvedValue({
      versions: [{ content: 'Активный промпт' }],
    });

    await expect(service.getActiveSystemPrompt()).resolves.toBe(
      'Активный промпт',
    );
    expect(prisma.promptTemplate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'default_system_prompt', isActive: true },
      }),
    );
  });

  it('откатывается на дефолтный промпт, если шаблона нет', async () => {
    prisma.promptTemplate.findFirst.mockResolvedValue(null);

    await expect(service.getActiveSystemPrompt()).resolves.toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });

  it('создаёт следующую версию и пишет аудит', async () => {
    prisma.promptTemplate.findUnique.mockResolvedValue({
      id: 'template-1',
      name: 'default_system_prompt',
    });
    prisma.promptVersion.findFirst.mockResolvedValue({ version: 2 });
    prisma.promptVersion.create.mockResolvedValue({
      id: 'version-3',
      templateId: 'template-1',
      version: 3,
      content: 'Новый промпт',
    });

    await expect(
      service.createVersion('template-1', 'Новый промпт', 'user-1'),
    ).resolves.toMatchObject({ version: 3 });
    expect(prisma.promptVersion.create).toHaveBeenCalledWith({
      data: {
        templateId: 'template-1',
        version: 3,
        content: 'Новый промпт',
      },
    });
    expect(audit.record).toHaveBeenCalledWith({
      userId: 'user-1',
      action: 'prompt.version.create',
      entityType: 'PromptTemplate',
      entityId: 'template-1',
      metadata: { name: 'default_system_prompt', version: 3 },
    });
  });

  it('не создаёт версию для несуществующего шаблона', async () => {
    prisma.promptTemplate.findUnique.mockResolvedValue(null);

    await expect(
      service.createVersion('missing', 'текст', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.promptVersion.create).not.toHaveBeenCalled();
  });

  it('засевает дефолтный промпт, если его нет', async () => {
    prisma.promptTemplate.findUnique.mockResolvedValue(null);
    prisma.promptTemplate.create.mockResolvedValue({ id: 'template-1' });

    await service.seedDefaultPrompt();

    expect(prisma.promptTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'default_system_prompt',
        versions: {
          create: { version: 1, content: DEFAULT_SYSTEM_PROMPT },
        },
      }),
    });
  });
});
