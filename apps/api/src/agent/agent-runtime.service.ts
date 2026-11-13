import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SkillManifestSchema } from '@skillwharf/shared';
import { BillingService } from '../billing/billing.service.js';
import type { EgressPolicy } from '../sandbox/egress.js';
import { AgentGatewayService } from '../security/agent-gateway.service.js';
import { extractSecretCandidates } from '../security/policy/secret-taint.js';
import type {
  PolicyDecision,
  ToolCallContext,
} from '../security/policy/policy.types.js';
import {
  PendingApprovalService,
  type PendingApprovalHold,
} from '../chat/persistence/pending-approval.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import type { AgentSkillSnapshot } from './agent-tools.service.js';
import { BackgroundJobsService } from '../jobs/background-jobs.service.js';
import type {
  ApprovalPrepareRequest,
  ApprovalPrepareResponse,
  AgentToolCall,
  ToolExecutionRequest,
  ToolExecutionResponse,
} from './contracts.js';
import {
  OZON_MCP_TOOL_NAME,
  WB_MCP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from './tools/tool-schemas.js';

/** Инструменты, результат которых считается taint-источником. */
const TAINT_SOURCE_TOOLS = new Set([
  WEB_SEARCH_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  WB_MCP_TOOL_NAME,
]);

interface ToolPrice {
  price: number;
  skillName: string;
  freeCallsLimit: number;
}

/** Цена Pay-per-Call/Freemium инструмента из манифеста навыка. */
function resolveToolPrice(
  skills: readonly AgentSkillSnapshot[],
  toolName: string,
): ToolPrice | null {
  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (!manifest.dependencies?.tools?.includes(toolName)) {
      continue;
    }

    const pricing = manifest.pricing;

    if (
      !pricing ||
      typeof pricing.price !== 'number' ||
      pricing.price <= 0 ||
      (pricing.model !== 'Pay-per-Call' && pricing.model !== 'Freemium')
    ) {
      return null;
    }

    return {
      price: pricing.price,
      skillName: manifest.name,
      freeCallsLimit: pricing.freeCallsLimit ?? 0,
    };
  }

  return null;
}

/** Egress-политика инструмента: объединение allowlist навыков. */
function resolveToolEgress(
  skills: readonly AgentSkillSnapshot[],
  toolName: string,
): EgressPolicy | undefined {
  const allowlist = new Set<string>();

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (
      !manifest.dependencies?.tools?.includes(toolName) ||
      !manifest.permissions.includes('network')
    ) {
      continue;
    }

    for (const domain of manifest.egress_allowlist ?? []) {
      allowlist.add(domain);
    }
  }

  return allowlist.size === 0 ? undefined : { allowlist: [...allowlist] };
}

/** `mcp_endpoint` навыка, объявившего MCP-инструмент. */
function resolveToolMcpEndpoint(
  skills: readonly AgentSkillSnapshot[],
  toolName: string,
): string | undefined {
  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (
      manifest.dependencies?.tools?.includes(toolName) &&
      manifest.mcp_endpoint !== undefined
    ) {
      return manifest.mcp_endpoint;
    }
  }

  return undefined;
}

/**
 * Выполнение инструментов и HITL-подготовка на стороне API.
 *
 * Policy engine, Pay-per-Outcome escrow и Ledger остаются в Gateway. Worker
 * присылает вызовы модели, получает результаты и продолжает граф.
 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly toolsService: AgentToolsService,
    private readonly billingService: BillingService,
    private readonly agentGateway: AgentGatewayService,
    private readonly pendingApprovals: PendingApprovalService,
    @Optional() private readonly jobs?: BackgroundJobsService,
  ) {}

  async executeTools(
    request: ToolExecutionRequest,
  ): Promise<ToolExecutionResponse> {
    const taintedSecrets = new Set<string>();

    const messages = await Promise.all(
      request.calls.map(async (call) => {
        if (!this.toolsService.has(call.name)) {
          return {
            toolCallId: call.id,
            name: call.name,
            content: `Инструмент «${call.name}» не найден`,
            status: 'error' as const,
          };
        }

        const decision = this.evaluate(call, request);
        const outcome = request.outcomePrices[call.name];
        let holdEntryId = request.preAuthorizedHolds[call.id];

        if (holdEntryId === undefined && outcome !== undefined) {
          const authorized = await this.billingService.authorizeHold(
            request.userId,
            outcome.price,
            randomUUID(),
          );

          holdEntryId = authorized.entryId;
        }

        const pricing = resolveToolPrice(request.skills, call.name);
        const beforeExecute =
          pricing === null
            ? undefined
            : async (): Promise<void> => {
                await this.billingService.checkAndChargeSkill(
                  request.userId,
                  pricing.skillName,
                  pricing.price,
                  pricing.freeCallsLimit,
                );
              };
        const egress = resolveToolEgress(request.skills, call.name);
        const endpoint = resolveToolMcpEndpoint(request.skills, call.name);

        let result: string;

        try {
          result = await this.toolsService.execute(call.name, decision.args, {
            ...(beforeExecute === undefined ? {} : { beforeExecute }),
            ...(egress === undefined ? {} : { egress }),
            ...(endpoint === undefined ? {} : { endpoint }),
          });
        } catch (error) {
          if (holdEntryId !== undefined) {
            await this.billingService.cancelHold(holdEntryId);
          }

          throw error;
        }

        if (holdEntryId !== undefined) {
          await this.billingService.captureHold(holdEntryId);
        }

        if (TAINT_SOURCE_TOOLS.has(call.name)) {
          for (const secret of extractSecretCandidates(result)) {
            taintedSecrets.add(secret);
          }
        }

        return {
          toolCallId: call.id,
          name: call.name,
          content: result,
        };
      }),
    );

    return { messages, taintedSecrets: [...taintedSecrets] };
  }

  async prepareApproval(
    request: ApprovalPrepareRequest,
  ): Promise<ApprovalPrepareResponse> {
    const holds: PendingApprovalHold[] = [];
    const holdMap: Record<string, string> = {};

    try {
      for (const call of request.calls) {
        this.evaluate(call, request);

        const outcome = request.outcomePrices[call.name];

        if (outcome === undefined) {
          continue;
        }

        const authorized = await this.billingService.authorizeHold(
          request.userId,
          outcome.price,
          `approval:${request.conversationId}:${call.id}`,
        );

        holds.push({
          callId: call.id,
          toolName: call.name,
          entryId: authorized.entryId,
        });
        holdMap[call.id] = authorized.entryId;
      }
    } catch (error) {
      await Promise.all(
        holds.map((hold) => this.billingService.cancelHold(hold.entryId)),
      );
      throw error;
    }

    const tools = request.calls.map((call) => call.name);
    const reason: 'approval' | 'payment' = request.calls.some(
      (call) => request.outcomePrices[call.name] !== undefined,
    )
      ? 'payment'
      : 'approval';

    await this.pendingApprovals.upsertPending({
      conversationId: request.conversationId,
      userId: request.userId,
      reason,
      tools,
      holds,
    });

    this.logger.log(
      JSON.stringify({
        event: 'hitl.approval_prepared',
        conversationId: request.conversationId,
        userId: request.userId,
        reason,
        tools,
      }),
    );

    await this.jobs?.notifyApprovalPending({
      conversationId: request.conversationId,
      userId: request.userId,
      reason,
      tools,
    });

    return { reason, tools, holds: holdMap };
  }

  async resolveApproval(
    conversationId: string,
    approved: boolean,
  ): Promise<boolean> {
    if (approved) {
      const count = await this.pendingApprovals.resolvePending(
        conversationId,
        'approved',
      );

      return count > 0;
    }

    const pending = await this.pendingApprovals.findPending(conversationId);

    if (pending === null) {
      return false;
    }

    await Promise.all(
      pending.holds.map((hold) => this.billingService.cancelHold(hold.entryId)),
    );
    await this.pendingApprovals.resolvePending(conversationId, 'rejected');

    return true;
  }

  private evaluate(
    call: AgentToolCall,
    request: Pick<
      ToolExecutionRequest,
      'userId' | 'userRole' | 'toolSkills' | 'taintedSecrets'
    >,
  ): PolicyDecision {
    const context: ToolCallContext = {
      userId: request.userId,
      role: request.userRole,
      skills: request.toolSkills[call.name] ?? [],
      taintedSecrets: request.taintedSecrets,
    };

    return this.agentGateway.validateToolCall(call.name, call.args, context);
  }
}
