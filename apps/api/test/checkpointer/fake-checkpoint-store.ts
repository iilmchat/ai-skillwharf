import { randomUUID } from 'node:crypto';

/**
 * In-memory замена Prisma Client для тестов checkpointer'а и
 * pending-approval persistence.
 *
 * Реализует только те операции и операторы `where`, которые используют
 * `PrismaCheckpointSaver` и `PendingApprovalService`, но с настоящими
 * unique-констрейнтами (P2002) и сортировкой, чтобы тесты ловили ошибки
 * хранения, а не мокали их.
 *
 * Состояние доступно снаружи для ассертов: `store.state`.
 *
 * @example
 * const { prisma, state } = createFakeCheckpointPrisma();
 * const saver = new PrismaCheckpointSaver(prisma as unknown as PrismaService);
 */

/** Prisma-подобная ошибка известного запроса (`code === 'P2002'` и т.п.). */
export class FakePrismaError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
  }
}

/** Скалярное значение поля, по которому можно фильтровать. */
export type FakeFilterValue = string | number | boolean | Date | null;

/** Условие на одно поле — подмножество Prisma-операторов. */
export interface FakeFieldFilter {
  equals?: FakeFilterValue;
  lt?: FakeFilterValue;
  gt?: FakeFilterValue;
  in?: readonly FakeFilterValue[];
  not?: FakeFilterValue | FakeFieldFilter;
}

/** `where`: равенство по полям либо условия `FakeFieldFilter`. */
export type FakeWhere = Record<string, FakeFilterValue | FakeFieldFilter>;

export type FakeOrderDirection = 'asc' | 'desc';

/** `orderBy`: один ключ или массив ключей (как в Prisma). */
export type FakeOrderBy =
  | Record<string, FakeOrderDirection>
  | readonly Record<string, FakeOrderDirection>[];

export interface FakeFindArgs {
  where?: FakeWhere;
  orderBy?: FakeOrderBy;
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
  distinct?: readonly string[];
}

export interface FakeCreateArgs<Row> {
  data: Partial<Row>;
  select?: Record<string, boolean>;
}

export interface FakeUpsertArgs<Row> {
  where: FakeWhere;
  create: Partial<Row>;
  update: Partial<Row>;
  select?: Record<string, boolean>;
}

export interface FakeUpdateArgs<Row> {
  where: FakeWhere;
  data: Partial<Row>;
  select?: Record<string, boolean>;
}

export interface FakeUpdateManyArgs<Row> {
  where?: FakeWhere;
  data: Partial<Row>;
}

export interface FakeDeleteManyArgs {
  where?: FakeWhere;
}

export interface FakeUpdateManyResult {
  count: number;
}

export interface FakeDeleteManyResult {
  count: number;
}

/** Делегат модели: методы, которые реально вызывают сервисы. */
export interface FakeDelegate<Row extends { id: string }> {
  create(args: FakeCreateArgs<Row>): Promise<Row>;
  upsert(args: FakeUpsertArgs<Row>): Promise<Row>;
  findFirst(args?: FakeFindArgs): Promise<Row | null>;
  findMany(args?: FakeFindArgs): Promise<Row[]>;
  update(args: FakeUpdateArgs<Row>): Promise<Row>;
  updateMany(args: FakeUpdateManyArgs<Row>): Promise<FakeUpdateManyResult>;
  deleteMany(args?: FakeDeleteManyArgs): Promise<FakeDeleteManyResult>;
}

/** Строка таблицы GraphCheckpoint. */
export interface FakeGraphCheckpointRecord {
  id: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  payload: Uint8Array;
  metadata: Uint8Array;
  createdAt: Date;
}

/** Строка таблицы GraphCheckpointWrite. */
export interface FakeGraphCheckpointWriteRecord {
  id: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  taskId: string;
  idx: number;
  taskPath: string;
  channel: string;
  value: Uint8Array;
  createdAt: Date;
}

/** Строка таблицы PendingApproval (JSON-колонки — как их вернул бы Prisma). */
export interface FakePendingApprovalRecord {
  id: string;
  conversationId: string;
  userId: string;
  reason: string;
  tools: unknown;
  holds: unknown;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** Внутреннее состояние fake-store; массивы мутируются in-place. */
export interface FakeCheckpointPrismaState {
  graphCheckpoints: FakeGraphCheckpointRecord[];
  graphCheckpointWrites: FakeGraphCheckpointWriteRecord[];
  pendingApprovals: FakePendingApprovalRecord[];
}

/** Prisma-подобный клиент (подмножество, нужное Sprint 15). */
export interface FakeCheckpointPrisma {
  graphCheckpoint: FakeDelegate<FakeGraphCheckpointRecord>;
  graphCheckpointWrite: FakeDelegate<FakeGraphCheckpointWriteRecord>;
  pendingApproval: FakeDelegate<FakePendingApprovalRecord>;
}

export interface FakeCheckpointStore {
  prisma: FakeCheckpointPrisma;
  state: FakeCheckpointPrismaState;
  /** Очищает все таблицы (для повторного использования в тестах). */
  reset: () => void;
}

/** Описание таблицы: unique-ключи и значения по умолчанию. */
interface FakeTableOptions<Row> {
  uniqueKeys: readonly (readonly string[])[];
  defaults: () => Partial<Row>;
}

const OPERATORS = new Set(['equals', 'lt', 'gt', 'in', 'not']);

function asRecord(row: object): Record<string, unknown> {
  return row as unknown as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  );
}

/** Объект с операторами, а не вложенное условие по уникальному ключу. */
function isFieldFilter(value: unknown): value is FakeFieldFilter {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);

  return keys.length > 0 && keys.every((key) => OPERATORS.has(key));
}

function fieldOf(row: object, field: string): unknown {
  return asRecord(row)[field];
}

function setField(row: object, field: string, value: unknown): void {
  asRecord(row)[field] = value;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
}

function compareFieldValues(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  throw new Error(
    `Fake Prisma: cannot compare ${typeof left} and ${typeof right}`,
  );
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (
    condition !== null &&
    typeof condition === 'object' &&
    !(condition instanceof Date) &&
    !Array.isArray(condition)
  ) {
    let matched = true;

    for (const [operator, operand] of Object.entries(
      condition as Record<string, unknown>,
    )) {
      if (!OPERATORS.has(operator)) {
        throw new Error(
          `Fake Prisma: unsupported where operator "${operator}"`,
        );
      }

      if (!matched) {
        break;
      }

      switch (operator) {
        case 'equals':
          matched = valuesEqual(value, operand);
          break;
        case 'lt':
          matched = compareFieldValues(value, operand) < 0;
          break;
        case 'gt':
          matched = compareFieldValues(value, operand) > 0;
          break;
        case 'in': {
          if (!Array.isArray(operand)) {
            throw new Error('Fake Prisma: "in" operator expects an array');
          }

          const items: readonly unknown[] = operand as unknown[];
          matched = items.some((item) => valuesEqual(value, item));
          break;
        }
        case 'not':
          matched = !matchesCondition(value, operand);
          break;
        default:
          matched = false;
      }
    }

    return matched;
  }

  return valuesEqual(value, condition);
}

function matchesWhere(row: object, where: FakeWhere | undefined): boolean {
  if (where === undefined) {
    return true;
  }

  return Object.entries(where).every(([field, condition]) => {
    if (field === 'AND' || field === 'OR' || field === 'NOT') {
      throw new Error(
        `Fake Prisma: boolean operator "${field}" is not supported`,
      );
    }

    const value = fieldOf(row, field);

    // Составной unique-ключ в Prisma — вложенный объект вида
    // `{ threadId_checkpointNs_checkpointId: { threadId, checkpointNs, checkpointId } }`.
    if (
      value === undefined &&
      isPlainObject(condition) &&
      !isFieldFilter(condition)
    ) {
      return Object.entries(condition).every(([nestedField, nestedCondition]) =>
        matchesCondition(fieldOf(row, nestedField), nestedCondition),
      );
    }

    return matchesCondition(value, condition);
  });
}

function normalizeOrderBy(
  orderBy: FakeOrderBy | undefined,
): Array<[string, FakeOrderDirection]> {
  if (orderBy === undefined) {
    return [];
  }

  const entries: readonly Record<string, FakeOrderDirection>[] = Array.isArray(
    orderBy,
  )
    ? orderBy
    : [orderBy];
  const keys: Array<[string, FakeOrderDirection]> = [];

  for (const entry of entries) {
    for (const [field, direction] of Object.entries(entry)) {
      keys.push([field, direction]);
    }
  }

  return keys;
}

function sortRows<Row extends object>(
  rows: readonly Row[],
  orderBy: FakeOrderBy | undefined,
): Row[] {
  const keys = normalizeOrderBy(orderBy);

  if (keys.length === 0) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const [field, direction] of keys) {
      const result = compareFieldValues(
        fieldOf(left, field),
        fieldOf(right, field),
      );

      if (result !== 0) {
        return direction === 'desc' ? -result : result;
      }
    }

    return 0;
  });
}

function applyPaging<Row>(
  rows: readonly Row[],
  skip: number | undefined,
  take: number | undefined,
): Row[] {
  let result = [...rows];

  if (skip !== undefined && skip > 0) {
    result = result.slice(skip);
  }

  if (take !== undefined) {
    result = result.slice(0, Math.max(0, take));
  }

  return result;
}

function applyDistinct<Row extends object>(
  rows: readonly Row[],
  distinct: readonly string[] | undefined,
): Row[] {
  if (distinct === undefined || distinct.length === 0) {
    return [...rows];
  }

  const seen = new Set<string>();

  return rows.filter((row) => {
    const key = JSON.stringify(
      distinct.map((field) => {
        const value = fieldOf(row, field);

        return value instanceof Date ? value.toISOString() : value;
      }),
    );

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

function project<Row extends object>(
  row: Row,
  select: Record<string, boolean> | undefined,
): Row {
  if (select === undefined) {
    return { ...row };
  }

  const result: Record<string, unknown> = {};

  for (const [field, included] of Object.entries(select)) {
    if (included) {
      result[field] = fieldOf(row, field);
    }
  }

  return result as unknown as Row;
}

function applyData<Row extends object>(row: Row, data: Partial<Row>): void {
  for (const [field, value] of Object.entries(asRecord(data))) {
    if (value !== undefined) {
      setField(row, field, value);
    }
  }
}

/**
 * Создаёт делегат таблицы поверх массива строк. Массив мутируется in-place,
 * чтобы состояние оставалось доступным снаружи.
 */
function createDelegate<Row extends { id: string }>(
  rows: Row[],
  options: FakeTableOptions<Row>,
): FakeDelegate<Row> {
  function assertUnique(candidate: Row, ignore?: Row): void {
    for (const key of options.uniqueKeys) {
      const duplicate = rows.some(
        (row) =>
          row !== ignore &&
          key.every((field) =>
            valuesEqual(fieldOf(row, field), fieldOf(candidate, field)),
          ),
      );

      if (duplicate) {
        throw new FakePrismaError(
          'P2002',
          `Unique constraint failed on the fields: (${key.join(', ')})`,
        );
      }
    }
  }

  function insert(data: Partial<Row>): Row {
    const row = { ...options.defaults(), ...data } as unknown as Row;

    if (typeof row.id !== 'string' || row.id === '') {
      setField(row, 'id', randomUUID());
    }

    if (rows.some((existing) => existing.id === row.id)) {
      throw new FakePrismaError(
        'P2002',
        'Unique constraint failed on the fields: (id)',
      );
    }

    assertUnique(row);
    rows.push(row);

    return row;
  }

  function findRow(where: FakeWhere | undefined): Row | undefined {
    return rows.find((row) => matchesWhere(row, where));
  }

  return {
    async create(args): Promise<Row> {
      return project(insert(args.data), args.select);
    },

    async upsert(args): Promise<Row> {
      const existing = findRow(args.where);

      if (existing !== undefined) {
        applyData(existing, args.update);

        return project(existing, args.select);
      }

      return project(insert(args.create), args.select);
    },

    async findFirst(args = {}): Promise<Row | null> {
      const found = sortRows(
        rows.filter((row) => matchesWhere(row, args.where)),
        args.orderBy,
      )[0];

      return found === undefined ? null : project(found, args.select);
    },

    async findMany(args = {}): Promise<Row[]> {
      const filtered = rows.filter((row) => matchesWhere(row, args.where));
      const sorted = sortRows(filtered, args.orderBy);
      const paged = applyPaging(sorted, args.skip, args.take);
      const distinct = applyDistinct(paged, args.distinct);

      return distinct.map((row) => project(row, args.select));
    },

    async update(args): Promise<Row> {
      const existing = findRow(args.where);

      if (existing === undefined) {
        throw new FakePrismaError(
          'P2025',
          'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
        );
      }

      applyData(existing, args.data);

      return project(existing, args.select);
    },

    async updateMany(args): Promise<FakeUpdateManyResult> {
      const matched = rows.filter((row) => matchesWhere(row, args.where));

      for (const row of matched) {
        applyData(row, args.data);
      }

      return { count: matched.length };
    },

    async deleteMany(args = {}): Promise<FakeDeleteManyResult> {
      const kept = rows.filter((row) => !matchesWhere(row, args.where));
      const count = rows.length - kept.length;

      rows.splice(0, rows.length, ...kept);

      return { count };
    },
  };
}

/**
 * Создаёт in-memory Prisma-подобный клиент с таблицами checkpointer'а и
 * ожидающих одобрений.
 */
export function createFakeCheckpointPrisma(): FakeCheckpointStore {
  const state: FakeCheckpointPrismaState = {
    graphCheckpoints: [],
    graphCheckpointWrites: [],
    pendingApprovals: [],
  };

  const prisma: FakeCheckpointPrisma = {
    graphCheckpoint: createDelegate(state.graphCheckpoints, {
      uniqueKeys: [['threadId', 'checkpointNs', 'checkpointId']],
      defaults: () => ({
        checkpointNs: '',
        parentCheckpointId: null,
        createdAt: new Date(),
      }),
    }),
    graphCheckpointWrite: createDelegate(state.graphCheckpointWrites, {
      uniqueKeys: [
        ['threadId', 'checkpointNs', 'checkpointId', 'taskId', 'idx'],
      ],
      defaults: () => ({
        checkpointNs: '',
        taskPath: '',
        createdAt: new Date(),
      }),
    }),
    pendingApproval: createDelegate(state.pendingApprovals, {
      uniqueKeys: [['conversationId']],
      defaults: () => ({
        status: 'pending',
        resolvedAt: null,
        createdAt: new Date(),
      }),
    }),
  };

  const reset = (): void => {
    state.graphCheckpoints.splice(0, state.graphCheckpoints.length);
    state.graphCheckpointWrites.splice(0, state.graphCheckpointWrites.length);
    state.pendingApprovals.splice(0, state.pendingApprovals.length);
  };

  return { prisma, state, reset };
}
