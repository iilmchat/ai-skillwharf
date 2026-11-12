import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { SkillsService } from './skills.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  installedSkill: {
    upsert: MockFn;
    findMany: MockFn;
    findUnique: MockFn;
    update: MockFn;
    delete: MockFn;
  };
}

const validSkill = `---
name: web-researcher-pro
version: 1.2.0
description: Глубокий поиск информации в вебе с последующей проверкой источников.
author:
  name: SkillWharf Team
  email: team@skillwharf.ru
  url: https://skillwharf.ru
permissions:
  - network
  - filesystem
dependencies:
  tools:
    - web_search
    - read_file
pricing:
  model: Pay-per-Call
  price: 5
  currency: RUB
  freeCallsLimit: 10
---

# Web Researcher Pro

Инструкции для LLM: используй инструмент web_search.
`;

interface UpsertArgs {
  where: { name: string };
  create: {
    name: string;
    version: string;
    author: string;
    manifest: Record<string, unknown>;
  };
  update: {
    version: string;
    author: string;
    manifest: Record<string, unknown>;
    isEnabled: boolean;
  };
}

describe('SkillsService', () => {
  let service: SkillsService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      installedSkill: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SkillsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(SkillsService);
  });

  describe('validateManifest', () => {
    it('валидирует корректный SKILL.md', () => {
      expect(service.validateManifest(validSkill)).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('возвращает ошибки, если обязательные поля отсутствуют', () => {
      const result = service.validateManifest(`---
name: web-researcher-pro
description: Без версии, автора и прав.
---

# Body
`);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(' ')).toMatch(/version|author|permissions/);
    });

    it('проверяет формат имени, версии и прав', () => {
      const result = service.validateManifest(`---
name: Web Researcher!
version: 1.0
description: Неверные значения.
author:
  name: Team
permissions:
  - teleport
---
`);

      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/name|version|permissions/);
    });

    it('сообщает об отсутствии YAML frontmatter', () => {
      const result = service.validateManifest('# Просто Markdown без заголовка');

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('frontmatter');
    });

    it('обрабатывает синтаксически неверный YAML', () => {
      const result = service.validateManifest(`---
name: [незакрытый массив
---
`);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('YAML');
    });

    it('отклоняет YAML, который не является объектом манифеста', () => {
      const result = service.validateManifest(`---
- просто список
---
`);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('installSkill', () => {
    it('валидирует манифест и сохраняет навык в каталог', async () => {
      prisma.installedSkill.upsert.mockResolvedValue({
        id: 'skill-1',
        name: 'web-researcher-pro',
      });

      const result = await service.installSkill(validSkill);

      expect(result).toMatchObject({ id: 'skill-1' });
      expect(prisma.installedSkill.upsert).toHaveBeenCalledTimes(1);

      const [args] = prisma.installedSkill.upsert.mock.calls[0] as [UpsertArgs];
      expect(args.where).toEqual({ name: 'web-researcher-pro' });
      expect(args.create).toMatchObject({
        name: 'web-researcher-pro',
        version: '1.2.0',
        author: 'SkillWharf Team',
      });
      expect(args.create.manifest).toMatchObject({
        name: 'web-researcher-pro',
        version: '1.2.0',
        permissions: ['network', 'filesystem'],
      });
      expect(args.update).toMatchObject({
        version: '1.2.0',
        author: 'SkillWharf Team',
        isEnabled: true,
      });
    });

    it('отклоняет установку невалидного навыка', async () => {
      await expect(
        service.installSkill(`---
name: BAD NAME
version: 1
---
`),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.installedSkill.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getInstalledSkills', () => {
    it('возвращает список установленных навыков', async () => {
      const skills = [
        { id: 'skill-1', name: 'web-researcher-pro' },
        { id: 'skill-2', name: 'code-reviewer' },
      ];
      prisma.installedSkill.findMany.mockResolvedValue(skills);

      await expect(service.getInstalledSkills()).resolves.toEqual(skills);
      expect(prisma.installedSkill.findMany).toHaveBeenCalledWith({
        orderBy: { installedAt: 'desc' },
      });
    });
  });

  describe('toggleSkill', () => {
    it('включает и выключает установленный навык', async () => {
      prisma.installedSkill.findUnique.mockResolvedValue({ id: 'skill-1' });
      prisma.installedSkill.update.mockResolvedValue({
        id: 'skill-1',
        isEnabled: false,
      });

      const result = await service.toggleSkill('skill-1', false);

      expect(result).toEqual({ id: 'skill-1', isEnabled: false });
      expect(prisma.installedSkill.update).toHaveBeenCalledWith({
        where: { id: 'skill-1' },
        data: { isEnabled: false },
      });
    });

    it('отклоняет переключение несуществующего навыка', async () => {
      prisma.installedSkill.findUnique.mockResolvedValue(null);

      await expect(
        service.toggleSkill('missing', true),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.installedSkill.update).not.toHaveBeenCalled();
    });
  });

  describe('uninstallSkill', () => {
    it('удаляет навык из каталога', async () => {
      prisma.installedSkill.findUnique.mockResolvedValue({ id: 'skill-1' });
      prisma.installedSkill.delete.mockResolvedValue({ id: 'skill-1' });

      await expect(service.uninstallSkill('skill-1')).resolves.toEqual({
        id: 'skill-1',
      });
      expect(prisma.installedSkill.delete).toHaveBeenCalledWith({
        where: { id: 'skill-1' },
      });
    });

    it('отклоняет удаление несуществующего навыка', async () => {
      prisma.installedSkill.findUnique.mockResolvedValue(null);

      await expect(
        service.uninstallSkill('missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.installedSkill.delete).not.toHaveBeenCalled();
    });
  });
});
