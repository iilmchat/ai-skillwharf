import { Injectable } from '@nestjs/common';
import { Prisma, type AuditLog } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

/** Запись аудита с полями, удобными для Control Plane UI. */
export type AuditLogView = AuditLog & {
  actor: string;
  actorEmail: string;
  target: string;
  targetType: string;
  targetId: string;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пишет запись аудита Control Plane. */
  record(entry: AuditEntry): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      },
    });
  }

  /** Последние записи аудита (свежие сверху). */
  async getLogs(limit = 100): Promise<AuditLogView[]> {
    const logs = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { email: true } } },
    });

    return logs.map(({ user, ...log }) => ({
      ...log,
      actor: user.email,
      actorEmail: user.email,
      target: `${log.entityType}: ${log.entityId}`,
      targetType: log.entityType,
      targetId: log.entityId,
    }));
  }
}
