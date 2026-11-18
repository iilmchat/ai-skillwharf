import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/**
 * In-memory Prisma для сквозного контрактного E2E `Chat → HITL → Ledger`.
 *
 * Реализует ровно те модели и операторы, которые используют `ChatService`,
 * `PendingApprovalService` и `BillingService` (включая escrow-операции
 * `authorizeHold`/`captureHold`/`cancelHold`), но с настоящими unique-ключами,
 * сравнением `Decimal` и rollback в `$transaction`. Тест проверяет состояние
 * `Wallet`/`LedgerEntry`, а не моки вызовов, поэтому ошибки атомарности и
 * двойного списания ловятся на уровне данных.
 *
 * Состояние доступно снаружи (`store.state`) для ассертов.
 */

type RowRecord = Record<string, unknown>;

export interface FakeWalletRow {
  id: string;
  userId: string;
  balance: Prisma.Decimal;
  heldBalance: Prisma.Decimal;
  updatedAt: Date;
}

export interface FakeLedgerRow {
  id: string;
  walletId: string;
  amount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  type: string;
  description: string;
  idempotencyKey: string;
  createdAt: Date;
  llmRouteName: string | null;
}

export interface FakeConversationRow {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

export interface FakeMessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
}

export interface FakeUserRow {
  id: string;
  email: string;
  role: string;
}

export interface FakePendingApprovalRow {
  id: string;
  conversationId: string;
  userId: string;
  reason: string;
  tools: unknown;
  holds: unknown;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  expiresAt: Date | null;
}

export interface FakeAgentPrismaState {
  users: FakeUserRow[];
  conversations: FakeConversationRow[];
  messages: FakeMessageRow[];
  pendingApprovals: FakePendingApprovalRow[];
  wallets: FakeWalletRow[];
  ledgerEntries: FakeLedgerRow[];
}

interface Where {
  [field: string]: unknown;
}

interface QueryArgs {
  where?: Where;
  orderBy?: Record<string, 'asc' | 'desc'>;
  take?: number;
  skip?: number;
  select?: Record<string, unknown>;
}

interface CreateArgs {
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
}

interface UpdateArgs {
  where: Where;
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
}

interface UpsertArgs {
  where: Where;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, unknown>;
}

export interface FakeAgentPrisma {
  user: {
    findUnique(args: QueryArgs): Promise<RowRecord | null>;
  };
  conversation: {
    create(args: CreateArgs): Promise<RowRecord>;
    findUnique(args: QueryArgs): Promise<RowRecord | null>;
    update(args: UpdateArgs): Promise<RowRecord>;
  };
  message: {
    create(args: CreateArgs): Promise<RowRecord>;
    findMany(args?: QueryArgs): Promise<RowRecord[]>;
  };
  pendingApproval: {
    upsert(args: UpsertArgs): Promise<RowRecord>;
    findFirst(args?: QueryArgs): Promise<RowRecord | null>;
    findMany(args?: QueryArgs): Promise<RowRecord[]>;
    updateMany(args: {
      where?: Where;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  wallet: {
    upsert(args: UpsertArgs): Promise<RowRecord>;
    updateMany(args: {
      where?: Where;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    findUnique(args: QueryArgs): Promise<RowRecord | null>;
    findUniqueOrThrow(args: QueryArgs): Promise<RowRecord>;
  };
  ledgerEntry: {
    create(args: CreateArgs): Promise<RowRecord>;
    findUnique(args: QueryArgs): Promise<RowRecord | null>;
    findFirst(args?: QueryArgs): Promise<RowRecord | null>;
    update(args: UpdateArgs): Promise<RowRecord>;
    aggregate(args: {
      where?: Where;
      _sum?: Record<string, true>;
    }): Promise<{ _sum: { amount: Prisma.Decimal | null } }>;
  };
  $transaction<T>(callback: (tx: FakeAgentPrisma) => Promise<T>): Promise<T>;
}

export interface FakeAgentPrismaStore {
  prisma: FakeAgentPrisma;
  state: FakeAgentPrismaState;
  reset: () => void;
}

function asRecord(row: object): RowRecord {
  return row as unknown as RowRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Prisma.Decimal) &&
    !Array.isArray(value)
  );
}

function toDecimal(value: unknown): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return new Prisma.Decimal(value);
  }

  throw new Error(`Ожидался Decimal, получено: ${typeof value}`);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (left instanceof Prisma.Decimal || right instanceof Prisma.Decimal) {
    try {
      return toDecimal(left).equals(toDecimal(right));
    } catch {
      return false;
    }
  }

  return left === right;
}

function compareValues(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  if (left instanceof Prisma.Decimal || right instanceof Prisma.Decimal) {
    return toDecimal(left).comparedTo(toDecimal(right));
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  throw new Error(
    `Fake Prisma: нельзя сравнить ${typeof left} и ${typeof right}`,
  );
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (!isRecord(condition)) {
    return valuesEqual(value, condition);
  }

  for (const [operator, operand] of Object.entries(condition)) {
    switch (operator) {
      case 'equals':
        if (!valuesEqual(value, operand)) {
          return false;
        }
        break;
      case 'gte':
        if (
          value === null ||
          value === undefined ||
          operand === null ||
          operand === undefined ||
          compareValues(value, operand) < 0
        ) {
          return false;
        }
        break;
      case 'gt':
        if (
          value === null ||
          value === undefined ||
          operand === null ||
          operand === undefined ||
          compareValues(value, operand) <= 0
        ) {
          return false;
        }
        break;
      case 'lt':
        if (
          value === null ||
          value === undefined ||
          operand === null ||
          operand === undefined ||
          compareValues(value, operand) >= 0
        ) {
          return false;
        }
        break;
      case 'in':
        if (
          !Array.isArray(operand) ||
          !operand.some((item) => valuesEqual(value, item))
        ) {
          return false;
        }
        break;
      default:
        throw new Error(`Fake Prisma: оператор "${operator}" не поддержан`);
    }
  }

  return true;
}

function matchesWhere(row: object, where: Where | undefined): boolean {
  if (where === undefined) {
    return true;
  }

  return Object.entries(where).every(([field, condition]) =>
    matchesCondition(asRecord(row)[field], condition),
  );
}

function findWalletForLedger(
  state: FakeAgentPrismaState,
  row: FakeLedgerRow,
): FakeWalletRow | undefined {
  return state.wallets.find((wallet) => wallet.id === row.walletId);
}

/**
 * Проекция `select`, включая связь `LedgerEntry.wallet`.
 *
 * BillingService читает `wallet: { select: { userId, balance, heldBalance } }`
 * при повторной проверке идемпотентности — без вложенной проекции escrow
 * replay вернул бы `undefined`.
 */
function project(
  row: object,
  select: Record<string, unknown> | undefined,
  state: FakeAgentPrismaState,
): RowRecord {
  if (select === undefined) {
    return { ...asRecord(row) };
  }

  const result: RowRecord = {};

  for (const [field, included] of Object.entries(select)) {
    if (included === true) {
      result[field] = asRecord(row)[field];
      continue;
    }

    if (
      field === 'wallet' &&
      isRecord(included) &&
      isRecord(included.select) &&
      row instanceof Object &&
      'walletId' in row
    ) {
      const wallet = findWalletForLedger(state, row as FakeLedgerRow);
      result[field] =
        wallet === undefined ? null : project(wallet, included.select, state);
    }
  }

  return result;
}

function sortRows<Row extends object>(
  rows: Row[],
  orderBy?: Record<string, 'asc' | 'desc'>,
): Row[] {
  if (orderBy === undefined) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const [field, direction] of Object.entries(orderBy)) {
      const result = compareValues(
        asRecord(left)[field],
        asRecord(right)[field],
      );

      if (result !== 0) {
        return direction === 'desc' ? -result : result;
      }
    }

    return 0;
  });
}

function paginate<Row>(rows: Row[], skip?: number, take?: number): Row[] {
  let result = [...rows];

  if (skip !== undefined && skip > 0) {
    result = result.slice(skip);
  }

  if (take !== undefined) {
    result = result.slice(0, Math.max(0, take));
  }

  return result;
}

function applyPlainData(row: RowRecord, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined) {
      row[field] = value;
    }
  }
}

/** Применяет `increment`/`decrement`/значение к денежному полю. */
function applyMoneyChange(
  row: RowRecord,
  field: 'balance' | 'heldBalance',
  change: unknown,
): void {
  if (change === undefined) {
    return;
  }

  const current = toDecimal(row[field]);

  if (isRecord(change) && 'increment' in change) {
    row[field] = current.plus(toDecimal(change.increment));
    return;
  }

  if (isRecord(change) && 'decrement' in change) {
    row[field] = current.minus(toDecimal(change.decrement));
    return;
  }

  row[field] = toDecimal(change);
}

/**
 * Создаёт in-memory Prisma-подобный клиент и состояние для ассертов.
 */
export function createFakeAgentPrisma(): FakeAgentPrismaStore {
  const state: FakeAgentPrismaState = {
    users: [],
    conversations: [],
    messages: [],
    pendingApprovals: [],
    wallets: [],
    ledgerEntries: [],
  };

  function createWallet(data: Record<string, unknown>): FakeWalletRow {
    const row: FakeWalletRow = {
      id: typeof data.id === 'string' ? data.id : randomUUID(),
      userId: typeof data.userId === 'string' ? data.userId : '',
      balance: toDecimal(data.balance ?? 0),
      heldBalance: toDecimal(data.heldBalance ?? 0),
      updatedAt: new Date(),
    };

    state.wallets.push(row);

    return row;
  }

  function createLedgerEntry(data: Record<string, unknown>): FakeLedgerRow {
    const row: FakeLedgerRow = {
      id: typeof data.id === 'string' ? data.id : randomUUID(),
      walletId: typeof data.walletId === 'string' ? data.walletId : '',
      amount: toDecimal(data.amount),
      balanceAfter: toDecimal(data.balanceAfter),
      type: typeof data.type === 'string' ? data.type : '',
      description: typeof data.description === 'string' ? data.description : '',
      idempotencyKey:
        typeof data.idempotencyKey === 'string' ? data.idempotencyKey : '',
      createdAt: new Date(),
      llmRouteName:
        typeof data.llmRouteName === 'string' ? data.llmRouteName : null,
    };

    state.ledgerEntries.push(row);

    return row;
  }

  function pendingRow(data: Record<string, unknown>): FakePendingApprovalRow {
    return {
      id: typeof data.id === 'string' ? data.id : randomUUID(),
      conversationId:
        typeof data.conversationId === 'string' ? data.conversationId : '',
      userId: typeof data.userId === 'string' ? data.userId : '',
      reason: typeof data.reason === 'string' ? data.reason : 'approval',
      tools: data.tools,
      holds: data.holds,
      status: typeof data.status === 'string' ? data.status : 'pending',
      createdAt: data.createdAt instanceof Date ? data.createdAt : new Date(),
      resolvedAt: data.resolvedAt instanceof Date ? data.resolvedAt : null,
      expiresAt: data.expiresAt instanceof Date ? data.expiresAt : null,
    };
  }

  const prisma: FakeAgentPrisma = {
    user: {
      async findUnique(args) {
        const row = state.users.find((user) => matchesWhere(user, args.where));

        return row === undefined ? null : project(row, args.select, state);
      },
    },
    conversation: {
      async create(args) {
        const row: FakeConversationRow = {
          id: typeof args.data.id === 'string' ? args.data.id : randomUUID(),
          title:
            typeof args.data.title === 'string'
              ? args.data.title
              : 'Новый диалог',
          createdAt: new Date(),
          updatedAt: new Date(),
          userId: typeof args.data.userId === 'string' ? args.data.userId : '',
        };

        state.conversations.push(row);

        return project(row, args.select, state);
      },
      async findUnique(args) {
        const row = state.conversations.find((conversation) =>
          matchesWhere(conversation, args.where),
        );

        return row === undefined ? null : project(row, args.select, state);
      },
      async update(args) {
        const row = state.conversations.find((conversation) =>
          matchesWhere(conversation, args.where),
        );

        if (row === undefined) {
          throw new Error('Fake Prisma: Conversation для update не найден');
        }

        applyPlainData(asRecord(row), args.data);
        row.updatedAt = new Date();

        return project(row, args.select, state);
      },
    },
    message: {
      async create(args) {
        const row: FakeMessageRow = {
          id: typeof args.data.id === 'string' ? args.data.id : randomUUID(),
          conversationId:
            typeof args.data.conversationId === 'string'
              ? args.data.conversationId
              : '',
          role: typeof args.data.role === 'string' ? args.data.role : 'user',
          content:
            typeof args.data.content === 'string' ? args.data.content : '',
          createdAt: new Date(),
        };

        state.messages.push(row);

        return project(row, args.select, state);
      },
      async findMany(args = {}) {
        const filtered = state.messages.filter((message) =>
          matchesWhere(message, args.where),
        );
        const sorted = sortRows(filtered, args.orderBy);
        const paged = paginate(sorted, args.skip, args.take);

        return paged.map((row) => project(row, args.select, state));
      },
    },
    pendingApproval: {
      async upsert(args) {
        const existing = state.pendingApprovals.find((row) =>
          matchesWhere(row, args.where),
        );

        if (existing !== undefined) {
          applyPlainData(asRecord(existing), args.update);

          return project(existing, args.select, state);
        }

        const row = pendingRow(args.create);
        state.pendingApprovals.push(row);

        return project(row, args.select, state);
      },
      async findFirst(args = {}) {
        const row = sortRows(
          state.pendingApprovals.filter((pending) =>
            matchesWhere(pending, args.where),
          ),
          args.orderBy,
        )[0];

        return row === undefined ? null : project(row, args.select, state);
      },
      async findMany(args = {}) {
        const filtered = state.pendingApprovals.filter((pending) =>
          matchesWhere(pending, args.where),
        );
        const sorted = sortRows(filtered, args.orderBy);
        const paged = paginate(sorted, args.skip, args.take);

        return paged.map((row) => project(row, args.select, state));
      },
      async updateMany(args) {
        const matched = state.pendingApprovals.filter((pending) =>
          matchesWhere(pending, args.where ?? {}),
        );

        for (const row of matched) {
          applyPlainData(asRecord(row), args.data);
        }

        return { count: matched.length };
      },
    },
    wallet: {
      async upsert(args) {
        const existing = state.wallets.find((wallet) =>
          matchesWhere(wallet, args.where),
        );

        if (existing !== undefined) {
          applyPlainData(asRecord(existing), args.update);

          return project(existing, args.select, state);
        }

        return project(createWallet(args.create), args.select, state);
      },
      async updateMany(args) {
        const matched = state.wallets.filter((wallet) =>
          matchesWhere(wallet, args.where ?? {}),
        );
        const data = args.data;

        for (const wallet of matched) {
          applyMoneyChange(asRecord(wallet), 'balance', data.balance);
          applyMoneyChange(asRecord(wallet), 'heldBalance', data.heldBalance);
          wallet.updatedAt = new Date();
        }

        return { count: matched.length };
      },
      async findUnique(args) {
        const row = state.wallets.find((wallet) =>
          matchesWhere(wallet, args.where),
        );

        return row === undefined ? null : project(row, args.select, state);
      },
      async findUniqueOrThrow(args) {
        const row = state.wallets.find((wallet) =>
          matchesWhere(wallet, args.where),
        );

        if (row === undefined) {
          throw new Error('Fake Prisma: Wallet не найден');
        }

        return project(row, args.select, state);
      },
    },
    ledgerEntry: {
      async create(args) {
        return project(createLedgerEntry(args.data), args.select, state);
      },
      async findUnique(args) {
        const row = state.ledgerEntries.find((entry) =>
          matchesWhere(entry, args.where),
        );

        return row === undefined ? null : project(row, args.select, state);
      },
      async findFirst(args = {}) {
        const row = state.ledgerEntries.find((entry) =>
          matchesWhere(entry, args.where ?? {}),
        );

        return row === undefined ? null : project(row, args.select, state);
      },
      async update(args) {
        const row = state.ledgerEntries.find((entry) =>
          matchesWhere(entry, args.where),
        );

        if (row === undefined) {
          throw new Error('Fake Prisma: LedgerEntry для update не найден');
        }

        applyPlainData(asRecord(row), args.data);

        return project(row, args.select, state);
      },
      async aggregate(args) {
        const matched = state.ledgerEntries.filter((entry) =>
          matchesWhere(entry, args.where ?? {}),
        );

        if (matched.length === 0) {
          return { _sum: { amount: null } };
        }

        const sum = matched
          .map((entry) => entry.amount)
          .reduce((left, right) => left.plus(right));

        return { _sum: { amount: sum } };
      },
    },
    async $transaction<T>(
      callback: (tx: FakeAgentPrisma) => Promise<T>,
    ): Promise<T> {
      // Снимок таблиц: при ошибке транзакции состояние откатывается, как в БД.
      const snapshot: FakeAgentPrismaState = {
        users: state.users.map((row) => ({ ...row })),
        conversations: state.conversations.map((row) => ({ ...row })),
        messages: state.messages.map((row) => ({ ...row })),
        pendingApprovals: state.pendingApprovals.map((row) => ({ ...row })),
        wallets: state.wallets.map((row) => ({ ...row })),
        ledgerEntries: state.ledgerEntries.map((row) => ({ ...row })),
      };

      try {
        return await callback(prisma);
      } catch (error) {
        state.users.splice(0, state.users.length, ...snapshot.users);
        state.conversations.splice(
          0,
          state.conversations.length,
          ...snapshot.conversations,
        );
        state.messages.splice(0, state.messages.length, ...snapshot.messages);
        state.pendingApprovals.splice(
          0,
          state.pendingApprovals.length,
          ...snapshot.pendingApprovals,
        );
        state.wallets.splice(0, state.wallets.length, ...snapshot.wallets);
        state.ledgerEntries.splice(
          0,
          state.ledgerEntries.length,
          ...snapshot.ledgerEntries,
        );

        throw error;
      }
    },
  };

  const reset = (): void => {
    state.users.splice(0, state.users.length);
    state.conversations.splice(0, state.conversations.length);
    state.messages.splice(0, state.messages.length);
    state.pendingApprovals.splice(0, state.pendingApprovals.length);
    state.wallets.splice(0, state.wallets.length);
    state.ledgerEntries.splice(0, state.ledgerEntries.length);
  };

  return { prisma, state, reset };
}
