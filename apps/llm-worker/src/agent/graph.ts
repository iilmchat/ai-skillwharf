import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  Annotation,
  Command,
  END,
  getWriter,
  interrupt,
  Overwrite,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import type {
  OutcomePrice,
  SkillSnapshot,
  ToolSkillContext,
  UserRole,
} from '../contracts.js';
import type { AgentBridgeService } from './bridge.service.js';
import {
  DEFAULT_OFFICE_AGENT_ID,
  OFFICE_TASKS,
  officeTaskForTool,
  type ChatOfficeEvent,
} from './office.js';
import type {
  InferenceChunk,
  LlmInferenceService,
} from '../llm/inference.service.js';
import { messageContentToText } from '../llm/inference.service.js';

/** Сколько последних раундов инструментов допускается. */
export const MAX_TOOL_ROUNDS = 5;

const TOOL_LIMIT_REPLY =
  'Достигнут лимит вызовов инструментов. Уточните запрос и попробуйте снова.';

/** Payload, который граф кладёт в interrupt() и отдаёт клиенту. */
export interface ChatApprovalInterrupt {
  type: 'approval';
  conversationId: string;
  userId: string;
  reason: 'approval' | 'payment';
  tools: string[];
  task: string;
}

/** Ответ пользователя, которым возобновляется граф после interrupt. */
export interface ChatApprovalResume {
  approved: boolean;
}

export const chatApprovalResumeSchema = z
  .object({ approved: z.boolean() })
  .strict();

export const chatApprovalInterruptSchema = z
  .object({
    type: z.literal('approval'),
    conversationId: z.string().min(1),
    userId: z.string().min(1),
    reason: z.enum(['approval', 'payment']),
    tools: z.array(z.string()),
    task: z.string(),
  })
  .strict();

export interface ChatStreamDelta {
  type: 'delta';
  text: string;
}

export type ChatStreamEvent = ChatStreamDelta | ChatOfficeEvent;

const ChatStateAnnotation = Annotation.Root({
  conversationId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  userId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  reply: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  skills: Annotation<SkillSnapshot[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  approvalRequiredTools: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  llmRoutes: Annotation<
    import('../contracts.js').LlmRouteSelection[]
  >({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  systemPrompt: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  outcomePrices: Annotation<Record<string, OutcomePrice>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  userRole: Annotation<UserRole>({
    reducer: (_previous, next) => next,
    default: () => 'user',
  }),
  toolSkills: Annotation<Record<string, ToolSkillContext[]>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  taintedSecrets: Annotation<string[]>({
    reducer: (previous, next) => [...new Set([...previous, ...next])],
    default: () => [],
  }),
  agentId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => DEFAULT_OFFICE_AGENT_ID,
  }),
  skillId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
});

export type ChatState = typeof ChatStateAnnotation.State;

/** Сбрасывает taint-канал перед новым сообщением пользователя. */
export function overwriteEmptySecrets(): string[] {
  return new Overwrite([]) as unknown as string[];
}

function lastMessage(messages: BaseMessage[]): BaseMessage | undefined {
  return messages[messages.length - 1];
}

function toolCallsOf(message: BaseMessage | undefined): ToolCall[] {
  return message instanceof AIMessage ? (message.tool_calls ?? []) : [];
}

function toolRounds(messages: BaseMessage[]): number {
  return messages.filter((message) => toolCallsOf(message).length > 0).length;
}

function callKey(call: ToolCall, index: number): string {
  return call.id === undefined || call.id === '' ? String(index) : call.id;
}

interface BuildGraphOptions {
  llm: LlmInferenceService;
  bridge: AgentBridgeService;
  checkpointer: BaseCheckpointSaver;
  tools: StructuredToolInterface[];
}

/**
 * Граф состояний LangGraph в стиле AgentExecutor:
 *
 * `llm` → (есть tool_calls?) → `tools` → `llm` → … → END.
 *
 * Инструменты не сериализуются в checkpoint: worker получает их описания от
 * API при каждом запуске/resume, а выполнение делегирует во внутренний API,
 * где живут policy engine, Ledger и песочница.
 */
export function buildChatGraph(options: BuildGraphOptions) {
  return new StateGraph(ChatStateAnnotation)
    .addNode('llm', async (state: ChatState, config) => {
      const emit = getWriter(config);
      let text = '';
      let response: AIMessage | undefined;

      const stream: AsyncGenerator<InferenceChunk, unknown> = options.llm.stream(
        state.messages,
        options.tools,
        state.llmRoutes,
        state.systemPrompt,
        {
          userId: state.userId,
          agentId: state.agentId,
          ...(state.skillId === '' ? {} : { skillId: state.skillId }),
        },
      );

      for await (const chunk of stream) {
        if (chunk.type === 'delta') {
          text += chunk.text;
          emit?.({
            type: 'delta',
            text: chunk.text,
          } satisfies ChatStreamDelta);
        } else {
          response = chunk.message;
        }
      }

      if (!response) {
        throw new Error('LLM не вернул финальное сообщение');
      }

      const calls = response.tool_calls ?? [];
      const limitReached = toolRounds(state.messages) >= MAX_TOOL_ROUNDS;
      const answer = text || messageContentToText(response.content);
      const reply =
        calls.length > 0 && !limitReached
          ? ''
          : answer || (limitReached ? TOOL_LIMIT_REPLY : '');

      if (reply && reply !== text) {
        emit?.({ type: 'delta', text: reply } satisfies ChatStreamDelta);
      }

      return {
        messages: [...state.messages, response],
        reply,
      };
    })
    .addNode('tools', async (state: ChatState, config) => {
      const emit = getWriter(config);
      const calls = toolCallsOf(lastMessage(state.messages));
      const approvalRequired = new Set(state.approvalRequiredTools);
      const callIds = calls.map((call, index) => callKey(call, index));
      const approvalCalls = calls
        .map((call, index) => ({ call, key: callIds[index]! }))
        .filter(({ call }) => approvalRequired.has(call.name));
      let preAuthorizedHolds: Record<string, string> = {};

      if (approvalCalls.length > 0) {
        const prepared = await options.bridge.prepareApproval({
          conversationId: state.conversationId,
          skills: state.skills,
          userId: state.userId,
          userRole: state.userRole,
          toolSkills: state.toolSkills,
          taintedSecrets: state.taintedSecrets,
          outcomePrices: state.outcomePrices,
          calls: approvalCalls.map(({ call, key }) => ({
            id: key,
            name: call.name,
            args: call.args,
          })),
        });

        preAuthorizedHolds = prepared.holds;

        const interruptPayload: ChatApprovalInterrupt = {
          type: 'approval',
          conversationId: state.conversationId,
          userId: state.userId,
          reason: prepared.reason,
          tools: prepared.tools,
          task: `${OFFICE_TASKS.waitingApproval}: ${officeTaskForTool(
            prepared.tools[0] ?? '',
          )}`,
        };

        const resume = interrupt<ChatApprovalInterrupt, ChatApprovalResume>(
          interruptPayload,
          { responseSchema: chatApprovalResumeSchema },
        );

        if (!resume.approved) {
          await options.bridge.resolveApproval(state.conversationId, false);

          return {
            messages: [
              ...state.messages,
              ...calls.map(
                (call) =>
                  new ToolMessage({
                    tool_call_id: call.id ?? '',
                    name: call.name,
                    content: 'Действие отклонено пользователем',
                    status: 'error',
                  }),
              ),
            ],
          };
        }

        await options.bridge.resolveApproval(state.conversationId, true);
      } else {
        for (const call of calls) {
          emit?.({
            type: 'office',
            conversationId: state.conversationId,
            agentId: DEFAULT_OFFICE_AGENT_ID,
            status: 'working',
            task: officeTaskForTool(call.name),
          } satisfies ChatOfficeEvent);
        }
      }

      const execution = await options.bridge.executeTools({
        conversationId: state.conversationId,
        skills: state.skills,
        userId: state.userId,
        userRole: state.userRole,
        toolSkills: state.toolSkills,
        taintedSecrets: state.taintedSecrets,
        outcomePrices: state.outcomePrices,
        calls: calls.map((call, index) => ({
          id: callIds[index]!,
          name: call.name,
          args: call.args,
        })),
        preAuthorizedHolds,
      });

      return {
        messages: [
          ...state.messages,
          ...execution.messages.map(
            (message) =>
              new ToolMessage({
                tool_call_id: message.toolCallId,
                name: message.name,
                content: message.content,
                ...(message.status === 'error'
                  ? { status: 'error' as const }
                  : {}),
              }),
          ),
        ],
        taintedSecrets: execution.taintedSecrets,
      };
    })
    .addEdge(START, 'llm')
    .addConditionalEdges('llm', (state: ChatState) => {
      if (toolCallsOf(lastMessage(state.messages)).length === 0) {
        return END;
      }

      return toolRounds(state.messages) > MAX_TOOL_ROUNDS ? END : 'tools';
    })
    .addEdge('tools', 'llm')
    .compile({ checkpointer: options.checkpointer });
}

/** Состояние нового запуска поверх checkpoint-треда диалога. */
export interface RunGraphInput {
  conversationId: string;
  userId: string;
  messages: BaseMessage[];
  skills: SkillSnapshot[];
  approvalRequiredTools: string[];
  outcomePrices: Record<string, OutcomePrice>;
  llmRoutes: import('../contracts.js').LlmRouteSelection[];
  systemPrompt: string;
  userRole: UserRole;
  toolSkills: Record<string, ToolSkillContext[]>;
  agentId: string;
  skillId?: string;
}

/** Конфиг checkpoint-треда: один диалог — один thread. */
export function graphConfig(conversationId: string): {
  configurable: { thread_id: string };
} {
  return { configurable: { thread_id: conversationId } };
}

/** Возобновление графа после HITL-подтверждения. */
export function resumeCommand(approved: boolean): Command {
  return new Command({
    resume: { approved } satisfies ChatApprovalResume,
  });
}
