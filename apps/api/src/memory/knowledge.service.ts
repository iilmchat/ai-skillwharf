import { Injectable, NotFoundException } from '@nestjs/common';
import { policyBlockedError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  createKnowledgeFolderSchema,
  knowledgeDocumentListSchema,
  knowledgeDocumentQuerySchema,
  knowledgeFolderViewSchema,
  type KnowledgeDocumentList,
  type KnowledgeFolderView,
} from './knowledge.schemas.js';

/** Папки и документы базы знаний (KB-38.1). */
@Injectable()
export class KnowledgeService {
  constructor(private readonly prisma: PrismaService) {}

  async listFolders(userId: string): Promise<KnowledgeFolderView[]> {
    const [folders, chunks] = await Promise.all([
      this.prisma.knowledgeFolder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.memoryChunk.findMany({
        where: { userId, folderId: { not: null } },
        select: { folderId: true, documentTitle: true },
      }),
    ]);

    return folders.map((folder) => {
      const related = chunks.filter((chunk) => chunk.folderId === folder.id);
      const documents = new Set(
        related
          .map((chunk) => chunk.documentTitle)
          .filter((title): title is string => title !== null),
      );

      return knowledgeFolderViewSchema.parse({
        ...folder,
        workspaceId: folder.workspaceId ?? null,
        description: folder.description,
        chunkCount: related.length,
        documentCount: documents.size,
        createdAt: folder.createdAt.toISOString(),
      });
    });
  }

  async createFolder(
    userId: string,
    raw: unknown,
  ): Promise<KnowledgeFolderView> {
    const input = createKnowledgeFolderSchema.parse(raw);
    const row = await this.prisma.knowledgeFolder.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      },
    });

    return knowledgeFolderViewSchema.parse({
      ...row,
      workspaceId: row.workspaceId ?? null,
      chunkCount: 0,
      documentCount: 0,
      createdAt: row.createdAt.toISOString(),
    });
  }

  async deleteFolder(userId: string, id: string): Promise<{ id: string }> {
    const folder = await this.prisma.knowledgeFolder.findUnique({
      where: { id },
    });

    if (folder === null) {
      throw new NotFoundException('Папка базы знаний не найдена');
    }

    if (folder.userId !== userId) {
      throw policyBlockedError('Недостаточно прав для удаления папки');
    }

    await this.prisma.knowledgeFolder.delete({ where: { id } });

    return { id };
  }

  async listDocuments(
    userId: string,
    raw: unknown,
  ): Promise<KnowledgeDocumentList> {
    const query = knowledgeDocumentQuerySchema.parse(raw);
    const where = {
      userId,
      ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
      ...(query.search === undefined
        ? {}
        : { content: { contains: query.search, mode: 'insensitive' as const } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.memoryChunk.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          folderId: true,
          documentTitle: true,
          source: true,
          content: true,
          pageNumber: true,
          createdAt: true,
        },
      }),
      this.prisma.memoryChunk.count({ where }),
    ]);

    return knowledgeDocumentListSchema.parse({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
    });
  }
}
