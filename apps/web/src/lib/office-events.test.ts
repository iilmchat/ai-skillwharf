import { describe, expect, it } from 'vitest';
import {
  officeHandoffSchema,
  parseOfficeEvent,
  readConversationId,
} from './office-events';
import { useOfficeStore } from '../store/office.store';

const HANDOFF = {
  type: 'agent_handoff',
  fromRole: 'Аналитик',
  toRole: 'Снабженец',
  reason: 'проверка дефицита комплектующих',
  conversationId: 'conv-1',
};

const STATUS_EVENT = {
  agentId: 'default',
  status: 'working',
  task: 'Считаю отчёт',
  reason: 'payment',
  conversationId: 'conv-1',
} as const;

describe('officeHandoffSchema', () => {
  it('принимает корректную передачу задачи', () => {
    expect(officeHandoffSchema.parse(HANDOFF)).toEqual({
      fromRole: 'Аналитик',
      toRole: 'Снабженец',
      reason: 'проверка дефицита комплектующих',
    });
  });

  it('отвергает пустые роли и причину', () => {
    expect(
      officeHandoffSchema.safeParse({ ...HANDOFF, fromRole: '' }).success,
    ).toBe(false);
    expect(
      officeHandoffSchema.safeParse({ ...HANDOFF, toRole: '' }).success,
    ).toBe(false);
    expect(
      officeHandoffSchema.safeParse({ ...HANDOFF, reason: '' }).success,
    ).toBe(false);
  });
});

describe('parseOfficeEvent', () => {
  it('разбирает agent_handoff и сохраняет роли с причиной', () => {
    const event = parseOfficeEvent(HANDOFF);

    expect(event?.type).toBe('agent_handoff');
    expect(event?.handoff).toEqual({
      fromRole: 'Аналитик',
      toRole: 'Снабженец',
      reason: 'проверка дефицита комплектующих',
    });
    expect(event?.conversationId).toBe('conv-1');
  });

  it('распознаёт передачу и без явного type', () => {
    const event = parseOfficeEvent({
      fromRole: 'Аналитик',
      toRole: 'Снабженец',
      reason: 'проверка дефицита комплектующих',
      conversationId: 'conv-1',
    });

    expect(event?.handoff?.toRole).toBe('Снабженец');
  });

  it('не ломается на невалидной передаче', () => {
    expect(
      parseOfficeEvent({ ...HANDOFF, reason: undefined }),
    ).toBeNull();
  });

  it('остаётся совместимым с обычным office_event', () => {
    const event = parseOfficeEvent({ ...STATUS_EVENT, extra: true });

    expect(event).toEqual({
      agentId: 'default',
      status: 'working',
      task: 'Считаю отчёт',
      reason: 'payment',
      conversationId: 'conv-1',
    });
  });

  it('отвергает событие без обязательных полей', () => {
    expect(parseOfficeEvent({ agentId: 'default' })).toBeNull();
    expect(parseOfficeEvent(null)).toBeNull();
  });

  it('читает conversationId из полезной нагрузки', () => {
    expect(readConversationId(HANDOFF)).toBe('conv-1');
    expect(readConversationId({ conversationId: '' })).toBeNull();
  });
});

describe('office.store: лента передач', () => {
  it('записывает последние передачи и ограничивает список восемью', () => {
    useOfficeStore.getState().reset();

    for (let index = 0; index < 10; index += 1) {
      useOfficeStore.getState().pushEvent({
        ...STATUS_EVENT,
        status: 'working' as const,
        type: 'agent_handoff',
        handoff: {
          fromRole: `Роль ${index}`,
          toRole: 'Снабженец',
          reason: `Причина ${index}`,
        },
      });
    }

    const handoffs = useOfficeStore.getState().handoffs;

    expect(handoffs).toHaveLength(8);
    expect(handoffs[0]?.reason).toBe('Причина 9');
    expect(handoffs[0]?.conversationId).toBe('conv-1');
    expect(handoffs[0]?.receivedAt).toBeGreaterThan(0);

    useOfficeStore.getState().reset();
    expect(useOfficeStore.getState().handoffs).toHaveLength(0);
  });
});
