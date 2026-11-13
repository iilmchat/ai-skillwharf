import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  approvalPrepareRequestSchema,
  approvalResolveRequestSchema,
  budgetReserveRequestSchema,
  budgetRefundRequestSchema,
  budgetSettleRequestSchema,
  checkpointDeleteRequestSchema,
  checkpointGetRequestSchema,
  checkpointListRequestSchema,
  checkpointPutRequestSchema,
  checkpointWritesRequestSchema,
  toolExecutionRequestSchema,
} from './contracts.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { CheckpointStoreService } from './checkpoint-store.service.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { LlmBudgetService } from './llm-budget.service.js';

/**
 * Внутренние эндпоинты для llm-worker.
 *
 * Наружу не публикуются: доступ только из compose-сети по общему токену.
 * Формат ответов — тот же Zod-контракт, что использует worker.
 */
@Controller('internal/agent')
@UseGuards(InternalTokenGuard)
export class AgentInternalController {
  constructor(
    private readonly runtime: AgentRuntimeService,
    private readonly budget: LlmBudgetService,
    private readonly checkpoints: CheckpointStoreService,
  ) {}

  @Post('tools/execute')
  @HttpCode(200)
  async executeTools(@Body() body: unknown) {
    const parsed = toolExecutionRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return this.runtime.executeTools(parsed.data);
  }

  @Post('approvals/prepare')
  @HttpCode(200)
  async prepareApproval(@Body() body: unknown) {
    const parsed = approvalPrepareRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return this.runtime.prepareApproval(parsed.data);
  }

  @Post('approvals/resolve')
  @HttpCode(200)
  async resolveApproval(@Body() body: unknown) {
    const parsed = approvalResolveRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return {
      resolved: await this.runtime.resolveApproval(
        parsed.data.conversationId,
        parsed.data.approved,
      ),
    };
  }

  @Post('llm/budget/reserve')
  @HttpCode(200)
  async reserveBudget(@Body() body: unknown) {
    const parsed = budgetReserveRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return this.budget.reserve(
      parsed.data.userId,
      parsed.data.estimatedPromptTokens,
    );
  }

  @Post('llm/budget/settle')
  @HttpCode(200)
  async settleBudget(@Body() body: unknown) {
    const parsed = budgetSettleRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.budget.settle(parsed.data);

    return { ok: true };
  }

  @Post('llm/budget/refund')
  @HttpCode(200)
  async refundBudget(@Body() body: unknown) {
    const parsed = budgetRefundRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.budget.refund(parsed.data.userId, parsed.data.reserved);

    return { ok: true };
  }

  @Post('checkpoints/get')
  @HttpCode(200)
  async getCheckpoint(@Body() body: unknown) {
    const parsed = checkpointGetRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return { record: await this.checkpoints.get(parsed.data) };
  }

  @Post('checkpoints/put')
  @HttpCode(200)
  async putCheckpoint(@Body() body: unknown) {
    const parsed = checkpointPutRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.checkpoints.put(parsed.data);

    return { ok: true };
  }

  @Post('checkpoints/writes')
  @HttpCode(200)
  async putWrites(@Body() body: unknown) {
    const parsed = checkpointWritesRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.checkpoints.putWrites(parsed.data);

    return { ok: true };
  }

  @Post('checkpoints/delete')
  @HttpCode(200)
  async deleteThread(@Body() body: unknown) {
    const parsed = checkpointDeleteRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.checkpoints.deleteThread(parsed.data.threadId);

    return { ok: true };
  }

  @Post('checkpoints/list')
  @HttpCode(200)
  async listCheckpoints(@Body() body: unknown) {
    const parsed = checkpointListRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    return { records: await this.checkpoints.list(parsed.data) };
  }
}
