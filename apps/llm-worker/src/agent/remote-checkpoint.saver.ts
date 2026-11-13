import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { CheckpointRecord } from '../contracts.js';
import type { AgentBridgeService } from './bridge.service.js';

/** Сериализация LangGraph (JsonPlus) всегда пишет JSON-подобный формат. */
const SERDE_TYPE = 'json';

type WritableConfig = {
  configurable: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
  };
};

/**
 * Checkpointer LangGraph поверх HTTP-хранилища API.
 *
 * Сериализация остаётся в worker'е: API хранит только непрозрачные байты
 * (`payload`, `metadata`, pending writes), поэтому не зависит от LangChain.
 */
export class RemoteCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly bridge: AgentBridgeService) {
    super();
  }

  async getTuple(
    config: RunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    const threadId = requireConfigString(config, 'thread_id');
    const checkpointNs = optionalConfigString(config, 'checkpoint_ns', {
      allowEmpty: true,
    }) ?? '';
    const requestedCheckpointId = optionalConfigString(
      config,
      'checkpoint_id',
      { emptyAsUndefined: true },
    ) ?? null;
    const record = await this.bridge.getCheckpoint(
      threadId,
      checkpointNs,
      requestedCheckpointId,
    );

    if (record === null) {
      return undefined;
    }

    return this.toTuple(
      record,
      requestedCheckpointId === null ? undefined : config,
    );
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = optionalConfigString(config, 'thread_id') ?? null;
    const checkpointNs = optionalConfigString(config, 'checkpoint_ns', {
      allowEmpty: true,
    });
    const checkpointId = optionalConfigString(config, 'checkpoint_id', {
      emptyAsUndefined: true,
    });
    const before =
      options?.before === undefined
        ? null
        : optionalConfigString(options.before, 'checkpoint_id', {
            emptyAsUndefined: true,
          }) ?? null;
    const records = await this.bridge.listCheckpoints({
      threadId,
      checkpointNs: checkpointNs ?? null,
      before,
      limit: options?.limit ?? null,
      filter: options?.filter ?? {},
    });

    for (const record of records) {
      const recordCheckpointId = configStringOf(record, 'checkpoint_id');

      if (
        checkpointId !== undefined &&
        recordCheckpointId !== checkpointId
      ) {
        continue;
      }

      yield await this.toTuple(record);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    if (checkpoint.id === '') {
      throw new Error(
        'Failed to put checkpoint. The passed checkpoint is missing a required "id" field.',
      );
    }

    const threadId = requireConfigString(config, 'thread_id');
    const checkpointNs = optionalConfigString(config, 'checkpoint_ns', {
      allowEmpty: true,
    }) ?? '';
    const parentCheckpointId = optionalConfigString(
      config,
      'checkpoint_id',
      { emptyAsUndefined: true },
    ) ?? null;
    const [serializedCheckpoint, serializedMetadata] = await Promise.all([
      this.serialize(copyCheckpoint(checkpoint)),
      this.serialize(metadata),
    ]);

    await this.bridge.putCheckpoint({
      threadId,
      checkpointNs,
      checkpointId: checkpoint.id,
      parentCheckpointId,
      checkpoint: serializedCheckpoint,
      metadata: serializedMetadata,
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
    const checkpointNs = optionalConfigString(config, 'checkpoint_ns', {
      allowEmpty: true,
    }) ?? '';

    if (taskId === '') {
      throw new Error(
        'Failed to put writes. The passed task id is empty; a non-empty task id is required.',
      );
    }

    const payload = [];

    for (const [index, write] of writes.entries()) {
      const [channel, value] = write;
      const specialIdx: number | undefined = WRITES_IDX_MAP[channel];

      payload.push({
        channel,
        idx: specialIdx ?? index,
        value: await this.serialize(value),
      });
    }

    await this.bridge.putWrites({
      threadId,
      checkpointNs,
      checkpointId,
      taskId,
      taskPath: taskPath ?? '',
      writes: payload,
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId === '') {
      throw new Error(
        'Invalid configurable value for "thread_id": empty string is not permitted.',
      );
    }

    await this.bridge.deleteThread(threadId);
  }

  private async toTuple(
    record: CheckpointRecord,
    explicitConfig?: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const pendingWrites: CheckpointPendingWrite[] = [];

    for (const write of record.pendingWrites) {
      pendingWrites.push([
        write.taskId,
        write.channel,
        await this.deserialize(write.value),
      ]);
    }

    const tuple: CheckpointTuple = {
      config:
        explicitConfig ??
        (record.config as unknown as RunnableConfig),
      checkpoint: (await this.deserialize(record.checkpoint)) as Checkpoint,
      metadata: (await this.deserialize(
        record.metadata,
      )) as CheckpointMetadata,
      pendingWrites,
    };

    if (record.parentConfig) {
      tuple.parentConfig = record.parentConfig as unknown as RunnableConfig;
    }

    return tuple;
  }

  private async serialize(value: unknown): Promise<string> {
    const [, bytes] = await this.serde.dumpsTyped(value);

    return Buffer.from(bytes).toString('base64');
  }

  private async deserialize(value: string): Promise<unknown> {
    return this.serde.loadsTyped(
      SERDE_TYPE,
      Buffer.from(value, 'base64'),
    );
  }
}

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

function requireConfigString(
  config: RunnableConfig,
  field: string,
  options: { allowEmpty?: boolean; emptyAsUndefined?: boolean } = {},
): string {
  const value = optionalConfigString(config, field, options);

  if (value === undefined) {
    throw new Error(
      `Failed to access checkpoint storage. The passed RunnableConfig is missing a required "${field}" field.`,
    );
  }

  return value;
}

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
      `Invalid configurable value for "${field}": expected a string.`,
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

function configStringOf(record: CheckpointRecord, field: string): string {
  const value = record.config.configurable[field];

  return typeof value === 'string' ? value : '';
}

/** Конфиг для нового треда (экспортируется для тестов и graph runner). */
export function threadConfig(conversationId: string): WritableConfig {
  return {
    configurable: {
      thread_id: conversationId,
      checkpoint_ns: '',
      checkpoint_id: '',
    },
  };
}
