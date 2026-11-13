import { Injectable } from '@nestjs/common';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  writesSortKey,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Сериализация LangGraph (JsonPlus) всегда пишет JSON-подобный формат. */
const SERDE_TYPE = 'json';

/** Значение колонки BYTEA в ответе Prisma. */
type ByteColumn = Uint8Array;

/**
 * Checkpointer LangGraph поверх PostgreSQL.
 *
 * Повторяет семантику эталонного `MemorySaver`, но состояние графа переживает
 * рестарт API: checkpoint'ы и pending writes лежат в таблицах
 * `GraphCheckpoint` / `GraphCheckpointWrite`, а не в памяти процесса.
 *
 * Сериализация — тот же `JsonPlusSerializer`, что и у `MemorySaver`:
 * `serde.dumpsTyped(...)` даёт `[type, Uint8Array]`, байты кладём в BYTEA,
 * при чтении вызываем `serde.loadsTyped('json', bytes)`.
 *
 * Соответствие методов `MemorySaver`:
 * - `getTuple` — точка по `checkpoint_id` либо последняя (`checkpointId desc`,
 *   uuid6 сортируется лексикографически по времени);
 * - `list` — async generator с `limit` / `before` / `filter`, как у MemorySaver;
 * - `put` — `copyCheckpoint`, id берётся из `checkpoint.id`, parent — из
 *   `config.configurable.checkpoint_id`;
 * - `putWrites` — служебные каналы (`WRITES_IDX_MAP`) не дедуплицируются,
 *   обычные (`idx >= 0`) игнорируют повтор по unique-ключу;
 * - `deleteThread` — удаляет и checkpoint'ы, и writes треда.
 */
@Injectable()
export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireConfigString(config, 'thread_id');
    const checkpointNs =
      optionalConfigString(config, 'checkpoint_ns', { allowEmpty: true }) ??
      '';
    const requestedCheckpointId = optionalConfigString(
      config,
      'checkpoint_id',
      { emptyAsUndefined: true },
    );

    const row =
      requestedCheckpointId === undefined
        ? await this.prisma.graphCheckpoint.findFirst({
            where: { threadId, checkpointNs },
            orderBy: { checkpointId: 'desc' },
          })
        : await this.prisma.graphCheckpoint.findFirst({
            where: {
              threadId,
              checkpointNs,
              checkpointId: requestedCheckpointId,
            },
          });

    if (!row) {
      return undefined;
    }

    const tuple: CheckpointTuple = {
      // При явном checkpoint_id отдаём исходный config, как MemorySaver.
      config:
        requestedCheckpointId === undefined
          ? {
              configurable: {
                thread_id: threadId,
                checkpoint_ns: checkpointNs,
                checkpoint_id: row.checkpointId,
              },
            }
          : config,
      checkpoint: (await this.deserialize(row.payload)) as Checkpoint,
      metadata: (await this.deserialize(row.metadata)) as CheckpointMetadata,
      pendingWrites: await this.loadPendingWrites(
        threadId,
        checkpointNs,
        row.checkpointId,
      ),
    };

    if (row.parentCheckpointId !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }

    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    let limit = options?.limit;
    const threadId = optionalConfigString(config, 'thread_id');
    const checkpointNs = optionalConfigString(config, 'checkpoint_ns', {
      allowEmpty: true,
    });
    const checkpointIdFilter = optionalConfigString(config, 'checkpoint_id', {
      emptyAsUndefined: true,
    });
    const beforeCheckpointId =
      options?.before === undefined
        ? undefined
        : optionalConfigString(options.before, 'checkpoint_id', {
            emptyAsUndefined: true,
          });

    const threadIds =
      threadId === undefined ? await this.listThreadIds() : [threadId];

    for (const currentThreadId of threadIds) {
      const namespaces =
        checkpointNs === undefined
          ? await this.listCheckpointNamespaces(currentThreadId)
          : [checkpointNs];

      for (const currentNamespace of namespaces) {
        const rows = await this.prisma.graphCheckpoint.findMany({
          where: {
            threadId: currentThreadId,
            checkpointNs: currentNamespace,
          },
          orderBy: { checkpointId: 'desc' },
        });

        for (const row of rows) {
          if (
            checkpointIdFilter !== undefined &&
            row.checkpointId !== checkpointIdFilter
          ) {
            continue;
          }

          // `before` — эксклюзивная граница, как у MemorySaver.
          if (
            beforeCheckpointId !== undefined &&
            row.checkpointId >= beforeCheckpointId
          ) {
            continue;
          }

          const metadata = (await this.deserialize(
            row.metadata,
          )) as CheckpointMetadata;

          if (
            options?.filter !== undefined &&
            !matchesMetadataFilter(metadata, options.filter)
          ) {
            continue;
          }

          if (limit !== undefined) {
            if (limit <= 0) {
              return;
            }

            limit -= 1;
          }

          const tuple: CheckpointTuple = {
            config: {
              configurable: {
                thread_id: currentThreadId,
                checkpoint_ns: currentNamespace,
                checkpoint_id: row.checkpointId,
              },
            },
            checkpoint: (await this.deserialize(row.payload)) as Checkpoint,
            metadata,
            pendingWrites: await this.loadPendingWrites(
              currentThreadId,
              currentNamespace,
              row.checkpointId,
            ),
          };

          if (row.parentCheckpointId !== null) {
            tuple.parentConfig = {
              configurable: {
                thread_id: currentThreadId,
                checkpoint_ns: currentNamespace,
                checkpoint_id: row.parentCheckpointId,
              },
            };
          }

          yield tuple;
        }
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = requireConfigString(config, 'thread_id');
    const checkpointNs =
      optionalConfigString(config, 'checkpoint_ns', { allowEmpty: true }) ??
      '';
    const parentCheckpointId = optionalConfigString(
      config,
      'checkpoint_id',
      { emptyAsUndefined: true },
    );

    if (checkpoint.id === '') {
      throw new Error(
        'Failed to put checkpoint. The passed checkpoint is missing a required "id" field.',
      );
    }

    const prepared = copyCheckpoint(checkpoint);
    const [payload, serializedMetadata] = await Promise.all([
      this.serialize(prepared),
      this.serialize(metadata),
    ]);

    await this.prisma.graphCheckpoint.upsert({
      where: {
        threadId_checkpointNs_checkpointId: {
          threadId,
          checkpointNs,
          checkpointId: checkpoint.id,
        },
      },
      create: {
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        parentCheckpointId: parentCheckpointId ?? null,
        payload,
        metadata: serializedMetadata,
      },
      update: {
        parentCheckpointId: parentCheckpointId ?? null,
        payload,
        metadata: serializedMetadata,
      },
    });

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void> {
    const threadId = requireConfigString(config, 'thread_id');
    const checkpointId = requireConfigString(config, 'checkpoint_id');
    const checkpointNs =
      optionalConfigString(config, 'checkpoint_ns', { allowEmpty: true }) ??
      '';

    if (taskId === '') {
      throw new Error(
        'Failed to put writes. The passed task id is empty; a non-empty task id is required.',
      );
    }

    const taskPathValue = taskPath ?? '';

    // Последовательно, а не Promise.all: несколько служебных writes одного
    // task'а пишут в один и тот же unique-ключ, и параллельный upsert на
    // PostgreSQL может отдать P2002.
    for (const [index, write] of writes.entries()) {
      const [channel, value] = write;
      const specialIdx: number | undefined = WRITES_IDX_MAP[channel];
      const idx = specialIdx ?? index;
      const serializedValue = await this.serialize(value);
      const key = {
        threadId,
        checkpointNs,
        checkpointId,
        taskId,
        idx,
      };

      if (idx >= 0) {
        // Как MemorySaver: обычные writes с тем же idx не перезаписываются.
        await this.prisma.graphCheckpointWrite.upsert({
          where: { threadId_checkpointNs_checkpointId_taskId_idx: key },
          create: {
            ...key,
            taskPath: taskPathValue,
            channel,
            value: serializedValue,
          },
          update: {},
        });
      } else {
        // Служебные каналы (error/interrupt/scheduled/resume) перезаписываются.
        await this.prisma.graphCheckpointWrite.upsert({
          where: { threadId_checkpointNs_checkpointId_taskId_idx: key },
          create: {
            ...key,
            taskPath: taskPathValue,
            channel,
            value: serializedValue,
          },
          update: {
            taskPath: taskPathValue,
            channel,
            value: serializedValue,
          },
        });
      }
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId === '') {
      throw new Error(
        'Invalid configurable value for "thread_id": empty string is not permitted.',
      );
    }

    await this.prisma.graphCheckpointWrite.deleteMany({ where: { threadId } });
    await this.prisma.graphCheckpoint.deleteMany({ where: { threadId } });
  }

  /** Pending writes точки, отсортированные по `(taskPath, taskId, idx)`. */
  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await this.prisma.graphCheckpointWrite.findMany({
      where: { threadId, checkpointNs, checkpointId },
    });

    const ordered = rows
      .map((row) => ({
        sortKey: writesSortKey(row.taskPath, row.taskId, row.idx),
        row,
      }))
      .sort((left, right) => compareWritesSortKeys(left.sortKey, right.sortKey));

    const pendingWrites: CheckpointPendingWrite[] = [];

    for (const { row } of ordered) {
      pendingWrites.push([
        row.taskId,
        row.channel,
        await this.deserialize(row.value),
      ]);
    }

    return pendingWrites;
  }

  /** Thread-id'ы, у которых есть хотя бы один checkpoint (для list без thread_id). */
  private async listThreadIds(): Promise<string[]> {
    const rows = await this.prisma.graphCheckpoint.findMany({
      distinct: ['threadId'],
      select: { threadId: true },
    });

    return rows.map((row) => row.threadId);
  }

  /** Пространства имён checkpoint'ов одного треда. */
  private async listCheckpointNamespaces(
    threadId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.graphCheckpoint.findMany({
      where: { threadId },
      distinct: ['checkpointNs'],
      select: { checkpointNs: true },
    });

    return rows.map((row) => row.checkpointNs);
  }

  private async serialize(value: unknown): Promise<Buffer> {
    const [, bytes] = await this.serde.dumpsTyped(value);

    return Buffer.from(bytes);
  }

  private async deserialize(value: ByteColumn): Promise<unknown> {
    const loaded: unknown = await this.serde.loadsTyped(SERDE_TYPE, value);

    return loaded;
  }
}

/** Значение `config.configurable` как объект с неизвестными полями. */
function configurableOf(config: RunnableConfig): Record<string, unknown> {
  const value: unknown = config.configurable;

  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Invalid RunnableConfig: "configurable" must be an object with a "thread_id" field.',
    );
  }

  return value as Record<string, unknown>;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

/**
 * Строковое поле `configurable`, которое обязано присутствовать и быть
 * непустым (например, `thread_id` при чтении/записи checkpoint'а).
 */
function requireConfigString(
  config: RunnableConfig,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = optionalConfigString(config, field, options);

  if (value === undefined) {
    throw new Error(
      `Failed to access checkpoint storage. The passed RunnableConfig is missing a required "${field}" field in its "configurable" property. When using a checkpointer, pass a "${field}" so the checkpointer knows which thread or checkpoint to use. Example: { configurable: { thread_id: "my-thread-id", checkpoint_id: "my-checkpoint-id" } }`,
    );
  }

  return value;
}

/**
 * Строковое поле `configurable`, которое может отсутствовать.
 *
 * `emptyAsUndefined` используется для `checkpoint_id`: пустая строка для
 * LangGraph означает «возьми последнюю точку», а не идентификатор.
 */
function optionalConfigString(
  config: RunnableConfig,
  field: string,
  options: { allowEmpty?: boolean; emptyAsUndefined?: boolean } = {},
): string | undefined {
  const { allowEmpty = false, emptyAsUndefined = false } = options;
  const raw = configurableOf(config)[field];

  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid configurable value for "${field}": expected a string, got ${describeValue(raw)}.`,
    );
  }

  if (raw === '') {
    if (allowEmpty) {
      return '';
    }

    if (emptyAsUndefined) {
      return undefined;
    }

    throw new Error(
      `Invalid configurable value for "${field}": empty string is not permitted.`,
    );
  }

  return raw;
}

/** Совпадение metadata с фильтром `list` (поверхностное равенство). */
function matchesMetadataFilter(
  metadata: CheckpointMetadata,
  filter: Record<string, unknown>,
): boolean {
  const record = metadata as unknown as Record<string, unknown>;

  return Object.entries(filter).every(
    ([key, expected]) => record[key] === expected,
  );
}
