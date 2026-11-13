import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import {
  errorEventSchema,
  graphEventSchema,
  type GraphContext,
  type GraphEvent,
  type ResumeGraphRequest,
  type RunGraphRequest,
} from '../contracts.js';
import { InternalApiError } from '../internal-api.client.js';
import {
  LlmInferenceService,
  LlmUnavailableError,
} from '../llm/inference.service.js';
import { AgentBridgeService } from './bridge.service.js';
import {
  buildChatGraph,
  chatApprovalInterruptSchema,
  graphConfig,
  overwriteEmptySecrets,
  type ChatApprovalInterrupt,
  type ChatState,
} from './graph.js';
import { DEFAULT_OFFICE_AGENT_ID } from './office.js';
import { RemoteCheckpointSaver } from './remote-checkpoint.saver.js';
import { createRemoteTools } from './tools.factory.js';

interface PendingInterrupt {
  interrupt: ChatApprovalInterrupt;
}

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);
  private readonly checkpointer: BaseCheckpointSaver;

  constructor(
    private readonly llm: LlmInferenceService,
    private readonly bridge: AgentBridgeService,
  ) {
    this.checkpointer = bridge.isConfigured()
      ? new RemoteCheckpointSaver(bridge)
      : new MemorySaver();
  }

  async *run(request: RunGraphRequest): AsyncGenerator<GraphEvent> {
    try {
      const graph = this.buildGraph(request);

      yield* this.consume(
        await graph.stream(
          {
            conversationId: request.conversationId,
            userId: request.userId,
            messages: toLangChainMessages(request.messages),
            skills: request.skills,
            approvalRequiredTools: request.approvalRequiredTools,
            outcomePrices: request.outcomePrices,
            llmRoutes: request.llmRoutes,
            systemPrompt: request.systemPrompt,
            userRole: request.userRole,
            toolSkills: request.toolSkills,
            taintedSecrets: overwriteEmptySecrets(),
            agentId: request.agentId ?? DEFAULT_OFFICE_AGENT_ID,
            skillId: request.skillId ?? '',
          },
          {
            ...graphConfig(request.conversationId),
            streamMode: ['custom', 'values'] as const,
          },
        ),
        graph,
        request,
      );
    } catch (error) {
      yield toErrorEvent(error);
    }
  }

  async *resume(request: ResumeGraphRequest): AsyncGenerator<GraphEvent> {
    try {
      const graph = this.buildGraph(request);

      yield* this.consume(
        await graph.stream(
          new Command({ resume: { approved: request.approved } }),
          {
            ...graphConfig(request.conversationId),
            streamMode: ['custom', 'values'] as const,
          },
        ),
        graph,
        request,
      );
    } catch (error) {
      yield toErrorEvent(error);
    }
  }

  private buildGraph(context: GraphContext) {
    return buildChatGraph({
      llm: this.llm,
      bridge: this.bridge,
      checkpointer: this.checkpointer,
      tools: createRemoteTools(context.tools),
    });
  }

  private async *consume(
    stream: AsyncIterable<unknown>,
    graph: ReturnType<typeof buildChatGraph>,
    context: GraphContext,
  ): AsyncGenerator<GraphEvent> {
    let reply = '';

    for await (const event of stream) {
      const [mode, chunk] = event as [string, unknown];

      if (mode === 'custom') {
        const parsed = graphEventSchema.safeParse(chunk);

        if (parsed.success && parsed.data.type !== 'done') {
          yield parsed.data;
        }

        continue;
      }

      if (mode === 'values') {
        const values = chunk as Partial<ChatState>;

        if (typeof values.reply === 'string') {
          reply = values.reply;
        }
      }
    }

    const pending = await this.findPendingInterrupt(graph, context);

    if (pending !== null) {
      yield {
        type: 'approval',
        conversationId: pending.interrupt.conversationId,
        userId: pending.interrupt.userId,
        reason: pending.interrupt.reason,
        tools: pending.interrupt.tools,
        task: pending.interrupt.task,
      };

      yield {
        type: 'done',
        conversationId: context.conversationId,
        reply,
        pendingApproval: true,
      };

      return;
    }

    yield {
      type: 'done',
      conversationId: context.conversationId,
      reply,
      pendingApproval: false,
    };
  }

  private async findPendingInterrupt(
    graph: ReturnType<typeof buildChatGraph>,
    context: GraphContext,
  ): Promise<PendingInterrupt | null> {
    const snapshot = await graph.getState(graphConfig(context.conversationId));

    if (snapshot.next.length === 0) {
      return null;
    }

    for (const task of snapshot.tasks) {
      for (const entry of task.interrupts ?? []) {
        const parsed = chatApprovalInterruptSchema.safeParse(entry.value);

        if (parsed.success) {
          return { interrupt: parsed.data };
        }
      }
    }

    return null;
  }
}

function toLangChainMessages(
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[],
): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return new SystemMessage(message.content);
      case 'assistant':
        return new AIMessage(message.content);
      default:
        return new HumanMessage(message.content);
    }
  });
}

function toErrorEvent(error: unknown): z.infer<typeof errorEventSchema> {
  if (error instanceof InternalApiError) {
    return {
      type: 'error',
      statusCode: error.statusCode,
      ...(error.code === undefined ? {} : { code: error.code }),
      message: error.message,
    };
  }

  if (error instanceof LlmUnavailableError) {
    return {
      type: 'error',
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    const statusCode = httpStatusOf(error);

    if (statusCode !== null) {
      return {
        type: 'error',
        statusCode,
        message: error.message,
      };
    }

    return { type: 'error', statusCode: 500, message: error.message };
  }

  return { type: 'error', statusCode: 500, message: String(error) };
}

function httpStatusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }

  const candidate = error as { status?: unknown; statusCode?: unknown };
  const raw = candidate.status ?? candidate.statusCode;

  return typeof raw === 'number' && raw >= 100 && raw <= 599 ? raw : null;
}
