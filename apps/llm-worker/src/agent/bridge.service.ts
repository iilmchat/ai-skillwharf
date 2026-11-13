import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  approvalPrepareRequestSchema,
  approvalPrepareResponseSchema,
  approvalResolveRequestSchema,
  budgetReserveRequestSchema,
  budgetReserveResponseSchema,
  budgetSettleRequestSchema,
  checkpointGetRequestSchema,
  checkpointListRequestSchema,
  checkpointListResponseSchema,
  checkpointPutRequestSchema,
  checkpointRecordSchema,
  checkpointWritesRequestSchema,
  toolExecutionRequestSchema,
  toolExecutionResponseSchema,
  type ApprovalPrepareRequest,
  type ApprovalPrepareResponse,
  type BudgetReservation,
  type BudgetSettleRequest,
  type CheckpointRecord,
  type ToolExecutionRequest,
  type ToolExecutionResponse,
} from '../contracts.js';
import { InternalApiClient } from '../internal-api.client.js';

const checkpointGetResponseSchema = z.object({
  record: checkpointRecordSchema.nullable(),
});

const okResponseSchema = z.object({ ok: z.boolean() });

const resolveResponseSchema = z.object({ resolved: z.boolean() });

/**
 * Мост worker → API для всего, что остаётся в Gateway: policy engine,
 * биллинг, HITL-записи, checkpoint-хранилище и дневной бюджет.
 */
@Injectable()
export class AgentBridgeService {
  private readonly logger = new Logger(AgentBridgeService.name);
  private readonly client = new InternalApiClient();

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async executeTools(
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionResponse> {
    const body = toolExecutionRequestSchema.parse(request);

    return this.client.post(
      '/internal/agent/tools/execute',
      body,
      toolExecutionResponseSchema,
    );
  }

  async prepareApproval(
    request: ApprovalPrepareRequest,
  ): Promise<ApprovalPrepareResponse> {
    const body = approvalPrepareRequestSchema.parse(request);

    return this.client.post(
      '/internal/agent/approvals/prepare',
      body,
      approvalPrepareResponseSchema,
    );
  }

  async resolveApproval(
    conversationId: string,
    approved: boolean,
  ): Promise<boolean> {
    const body = approvalResolveRequestSchema.parse({
      conversationId,
      approved,
    });
    const response = await this.client.post(
      '/internal/agent/approvals/resolve',
      body,
      resolveResponseSchema,
    );

    return response.resolved;
  }

  async reserveBudget(
    userId: string,
    estimatedPromptTokens: number,
  ): Promise<BudgetReservation> {
    if (!this.client.isConfigured()) {
      return { reserved: 0, tracked: false };
    }

    const body = budgetReserveRequestSchema.parse({
      userId,
      estimatedPromptTokens,
    });

    return this.client.post(
      '/internal/agent/llm/budget/reserve',
      body,
      budgetReserveResponseSchema,
    );
  }

  async settleBudget(request: BudgetSettleRequest): Promise<void> {
    if (!this.client.isConfigured()) {
      return;
    }

    const body = budgetSettleRequestSchema.parse(request);

    await this.client.post('/internal/agent/llm/budget/settle', body, okResponseSchema);
  }

  async refundBudget(userId: string, reserved: number): Promise<void> {
    if (!this.client.isConfigured() || reserved === 0) {
      return;
    }

    await this.client.post(
      '/internal/agent/llm/budget/refund',
      { userId, reserved },
      okResponseSchema,
    );
  }

  async getCheckpoint(
    threadId: string,
    checkpointNs: string,
    checkpointId: string | null,
  ): Promise<CheckpointRecord | null> {
    const body = checkpointGetRequestSchema.parse({
      threadId,
      checkpointNs,
      checkpointId,
    });
    const response = await this.client.post(
      '/internal/agent/checkpoints/get',
      body,
      checkpointGetResponseSchema,
    );

    return response.record;
  }

  async putCheckpoint(
    request: z.infer<typeof checkpointPutRequestSchema>,
  ): Promise<void> {
    const body = checkpointPutRequestSchema.parse(request);

    await this.client.post(
      '/internal/agent/checkpoints/put',
      body,
      okResponseSchema,
    );
  }

  async putWrites(
    request: z.infer<typeof checkpointWritesRequestSchema>,
  ): Promise<void> {
    const body = checkpointWritesRequestSchema.parse(request);

    await this.client.post(
      '/internal/agent/checkpoints/writes',
      body,
      okResponseSchema,
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.client.post(
      '/internal/agent/checkpoints/delete',
      { threadId },
      okResponseSchema,
    );
  }

  async listCheckpoints(
    request: z.infer<typeof checkpointListRequestSchema>,
  ): Promise<CheckpointRecord[]> {
    const body = checkpointListRequestSchema.parse(request);
    const response = await this.client.post(
      '/internal/agent/checkpoints/list',
      body,
      checkpointListResponseSchema,
    );

    this.logger.debug(`checkpoints.list: ${response.records.length}`);

    return response.records;
  }
}
