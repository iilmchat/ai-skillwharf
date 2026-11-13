import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CheckpointRecord,
  checkpointGetRequestSchema,
  checkpointListRequestSchema,
  checkpointPutRequestSchema,
  checkpointWritesRequestSchema,
} from './contracts.js';
import type { z } from 'zod';

type GetRequest = z.infer<typeof checkpointGetRequestSchema>;
type PutRequest = z.infer<typeof checkpointPutRequestSchema>;
type WritesRequest = z.infer<typeof checkpointWritesRequestSchema>;
type ListRequest = z.infer<typeof checkpointListRequestSchema>;

/**
 * Хранилище checkpoint'ов LangGraph в PostgreSQL.
 *
 * API не сериализует состояние: worker присылает уже готовые байты JsonPlus,
 * а Gateway только раскладывает их по таблицам. Поэтому `@langchain/*` здесь
 * не нужен, а формат checkpoint'а остаётся совместимым с прежним saver'ом.
 */
@Injectable()
export class CheckpointStoreService {
  private readonly logger = new Logger(CheckpointStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  async get(request: GetRequest): Promise<CheckpointRecord | null> {
    const row =
      request.checkpointId === null
        ? await this.prisma.graphCheckpoint.findFirst({
            where: {
              threadId: request.threadId,
              checkpointNs: request.checkpointNs,
            },
            orderBy: { checkpointId: 'desc' },
          })
        : await this.prisma.graphCheckpoint.findFirst({
            where: {
              threadId: request.threadId,
              checkpointNs: request.checkpointNs,
              checkpointId: request.checkpointId,
            },
          });

    if (row === null) {
      return null;
    }

    return this.toRecord(row);
  }

  async put(request: PutRequest): Promise<void> {
    await this.prisma.graphCheckpoint.upsert({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId: request.threadId,
          checkpointNs: request.checkpointNs,
          checkpointId: request.checkpointId,
        },
      },
      create: {
        threadId: request.threadId,
        checkpointNs: request.checkpointNs,
        checkpointId: request.checkpointId,
        parentCheckpointId: request.parentCheckpointId,
        payload: Buffer.from(request.checkpoint, 'base64'),
        metadata: Buffer.from(request.metadata, 'base64'),
      },
      update: {
        parentCheckpointId: request.parentCheckpointId,
        payload: Buffer.from(request.checkpoint, 'base64'),
        metadata: Buffer.from(request.metadata, 'base64'),
      },
    });
  }

  async putWrites(request: WritesRequest): Promise<void> {
    for (const write of request.writes) {
      const key = {
        threadId: request.threadId,
        checkpointNs: request.checkpointNs,
        checkpointId: request.checkpointId,
        taskId: request.taskId,
        idx: write.idx,
      };
      const value = Buffer.from(write.value, 'base64');

      if (write.idx >= 0) {
        await this.prisma.graphCheckpointWrite.upsert({
          where: { threadId_checkpointNs_checkpointId_taskId_idx: key },
          create: {
            ...key,
            taskPath: request.taskPath,
            channel: write.channel,
            value,
          },
          update: {},
        });
      } else {
        await this.prisma.graphCheckpointWrite.upsert({
          where: { threadId_checkpointNs_checkpointId_taskId_idx: key },
          create: {
            ...key,
            taskPath: request.taskPath,
            channel: write.channel,
            value,
          },
          update: {
            taskPath: request.taskPath,
            channel: write.channel,
            value,
          },
        });
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.prisma.graphCheckpointWrite.deleteMany({ where: { threadId } });
    await this.prisma.graphCheckpoint.deleteMany({ where: { threadId } });
  }

  async list(request: ListRequest): Promise<CheckpointRecord[]> {
    const threadIds =
      request.threadId === null ? await this.listThreadIds() : [request.threadId];
    const records: CheckpointRecord[] = [];

    for (const threadId of threadIds) {
      const namespaces =
        request.checkpointNs === null
          ? await this.listNamespaces(threadId)
          : [request.checkpointNs];

      for (const checkpointNs of namespaces) {
        const rows = await this.prisma.graphCheckpoint.findMany({
          where: { threadId, checkpointNs },
          orderBy: { checkpointId: 'desc' },
        });

        for (const row of rows) {
          if (request.before !== null && row.checkpointId >= request.before) {
            continue;
          }

          if (request.limit !== null && records.length >= request.limit) {
            return records;
          }

          records.push(await this.toRecord(row));
        }
      }
    }

    return records;
  }

  private async toRecord(row: {
    threadId: string;
    checkpointNs: string;
    checkpointId: string;
    parentCheckpointId: string | null;
    payload: Uint8Array;
    metadata: Uint8Array;
  }): Promise<CheckpointRecord> {
    const writes = await this.prisma.graphCheckpointWrite.findMany({
      where: {
        threadId: row.threadId,
        checkpointNs: row.checkpointNs,
        checkpointId: row.checkpointId,
      },
      orderBy: [{ taskPath: 'asc' }, { taskId: 'asc' }, { idx: 'asc' }],
    });

    return {
      config: {
        configurable: {
          thread_id: row.threadId,
          checkpoint_ns: row.checkpointNs,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint: Buffer.from(row.payload).toString('base64'),
      metadata: Buffer.from(row.metadata).toString('base64'),
      parentConfig:
        row.parentCheckpointId === null
          ? null
          : {
              configurable: {
                thread_id: row.threadId,
                checkpoint_ns: row.checkpointNs,
                checkpoint_id: row.parentCheckpointId,
              },
            },
      pendingWrites: writes.map((write) => ({
        taskId: write.taskId,
        channel: write.channel,
        value: Buffer.from(write.value).toString('base64'),
      })),
    };
  }

  private async listThreadIds(): Promise<string[]> {
    const rows = await this.prisma.graphCheckpoint.findMany({
      distinct: ['threadId'],
      select: { threadId: true },
    });

    return rows.map((row) => row.threadId);
  }

  private async listNamespaces(threadId: string): Promise<string[]> {
    const rows = await this.prisma.graphCheckpoint.findMany({
      where: { threadId },
      distinct: ['checkpointNs'],
      select: { checkpointNs: true },
    });

    return rows.map((row) => row.checkpointNs);
  }
}
