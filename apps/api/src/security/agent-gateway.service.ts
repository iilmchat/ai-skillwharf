import { Injectable, Logger, Optional } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { policyBlockedError } from '../common/api-error.js';
import type {
  PolicyDecision,
  ToolCallContext,
  ToolSkillContext,
  UserRole,
} from './policy/policy.types.js';
import {
  containsSecretValue,
  maskSecretValues,
} from './policy/secret-taint.js';
import { analyzeShell, type ShellAnalysis } from './policy/shell-analyzer.js';
import {
  EXEC_COMMAND_ALLOWLIST,
  SANDBOX_COMMAND_ALLOWLIST,
  getToolPolicy,
  type ToolPolicy,
} from './policy/tool-policies.js';

/**
 * Runtime-политики Agent Gateway (ADR 0004): модель не является границей
 * безопасности, поэтому каждый вызов инструмента проверяется декларативным
 * policy engine до выполнения.
 *
 * Порядок проверок: известность инструмента -> роль -> разрешение навыка ->
 * Zod-схема аргументов -> структурный анализ shell-кода -> egress -> taint.
 * Любая блокировка отдаёт клиенту единый JSON (`errors.policy_blocked`) и
 * асинхронно пишет append-only запись аудита без значений аргументов.
 */

/** Коды причин блокировки вызова. */
export const POLICY_VIOLATION = {
  TOOL_UNKNOWN: 'POLICY_TOOL_UNKNOWN',
  SCHEMA_INVALID: 'POLICY_SCHEMA_INVALID',
  ROLE_DENIED: 'POLICY_ROLE_DENIED',
  PERMISSION_DENIED: 'POLICY_PERMISSION_DENIED',
  COMMAND_DENIED: 'POLICY_COMMAND_DENIED',
  NETWORK_DENIED: 'POLICY_NETWORK_DENIED',
  TAINT_BLOCKED: 'POLICY_TAINT_BLOCKED',
} as const;

/** Код причины блокировки вызова. */
export type PolicyViolationCode =
  (typeof POLICY_VIOLATION)[keyof typeof POLICY_VIOLATION];

/** Контекст по умолчанию: анонимный гость без навыков и taint-секретов. */
const DEFAULT_CONTEXT: ToolCallContext = {
  userId: 'anonymous',
  role: 'guest',
  skills: [],
  taintedSecrets: [],
};

/** Роли, которым разрешены инструменты навыков с разрешением `secrets`. */
const SECRETS_ROLES: ReadonlySet<UserRole> = new Set(['admin', 'owner']);

/** Внутренняя ошибка политики: перехватывается и превращается в ApiException. */
class PolicyViolation extends Error {
  constructor(
    readonly code: PolicyViolationCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'PolicyViolation';
  }
}

@Injectable()
export class AgentGatewayService {
  private readonly logger = new Logger(AgentGatewayService.name);

  constructor(
    @Optional() private readonly auditService?: AuditService,
  ) {}

  /**
   * Проверяет аргументы вызова инструмента и возвращает санитизированные
   * аргументы вместе с решениями по egress и taint.
   *
   * Без контекста вызов трактуется как анонимный гость: это безопасное
   * поведение по умолчанию и обратная совместимость для unit-тестов.
   */
  validateToolCall(
    toolName: string,
    args: unknown,
    context?: ToolCallContext,
  ): PolicyDecision {
    const effectiveContext = context ?? DEFAULT_CONTEXT;

    try {
      return this.evaluate(toolName, args, effectiveContext);
    } catch (error) {
      if (!(error instanceof PolicyViolation)) {
        throw error;
      }

      this.recordBlockedCall(effectiveContext, toolName, error.code);

      throw policyBlockedError(
        `Действие заблокировано политикой безопасности: ${error.code}${
          error.detail === undefined ? '' : ` (${error.detail})`
        }`,
      );
    }
  }

  /** Единая точка применения политик; бросает PolicyViolation при блокировке. */
  private evaluate(
    toolName: string,
    rawArgs: unknown,
    context: ToolCallContext,
  ): PolicyDecision {
    const policy = getToolPolicy(toolName);

    if (policy === undefined) {
      throw new PolicyViolation(
        POLICY_VIOLATION.TOOL_UNKNOWN,
        `инструмент «${toolName}» не объявлен в реестре политик`,
      );
    }

    this.assertRole(policy, context);
    this.assertSecretsPermission(context);

    const args = this.parseArgs(policy, rawArgs);

    this.assertSkillPermission(policy, context);

    const shellAnalysis =
      policy.shell === undefined
        ? null
        : this.analyzeToolShell(policy, args);

    const networkRequested =
      shellAnalysis === null
        ? policy.egressRequested
        : shellAnalysis.networkRequested;

    const egressAllowlist = collectEgressAllowlist(context.skills);

    if (
      networkRequested &&
      (!hasNetworkPermission(context.skills) || egressAllowlist.length === 0)
    ) {
      throw new PolicyViolation(
        POLICY_VIOLATION.NETWORK_DENIED,
        'нет навыка с разрешением network или пуст egress_allowlist',
      );
    }

    const tainted = this.applyTaint(policy, args, context.taintedSecrets);

    return {
      toolName,
      args: tainted.args,
      egress: { requested: networkRequested, allowlist: egressAllowlist },
      taint: { detected: tainted.detected, masked: tainted.masked },
    };
  }

  /** Роль пользователя должна быть разрешена политикой инструмента. */
  private assertRole(policy: ToolPolicy, context: ToolCallContext): void {
    if (!policy.allowedRoles.includes(context.role)) {
      throw new PolicyViolation(
        POLICY_VIOLATION.ROLE_DENIED,
        `роль ${context.role} не может вызывать ${policy.name}`,
      );
    }
  }

  /**
   * Инструменты навыков с разрешением `secrets` доступны только
   * администраторам и владельцу: они работают с чужими секретами.
   */
  private assertSecretsPermission(context: ToolCallContext): void {
    const secretsSkill = context.skills.some((skill) =>
      skill.permissions.includes('secrets'),
    );

    if (secretsSkill && !SECRETS_ROLES.has(context.role)) {
      throw new PolicyViolation(
        POLICY_VIOLATION.ROLE_DENIED,
        'инструменты навыков с разрешением secrets доступны только admin/owner',
      );
    }
  }

  /** Строгая Zod-валидация аргументов (лишние ключи запрещены). */
  private parseArgs(
    policy: ToolPolicy,
    rawArgs: unknown,
  ): Record<string, unknown> {
    const parsed = policy.schema.safeParse(rawArgs);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => {
          const path = issue.path.length === 0 ? 'args' : issue.path.join('.');

          return `${path}:${issue.code}`;
        })
        .join(', ');

      throw new PolicyViolation(POLICY_VIOLATION.SCHEMA_INVALID, detail);
    }

    return parsed.data as Record<string, unknown>;
  }

  /**
   * Если навыки переданы, нужен хотя бы один с требуемым разрешением.
   * Пустой список навыков означает базовый набор инструментов без навыков.
   * Разрешение `network` покрывает и `shell`: навыку с сетевым доступом
   * разрешено запускать команды, которым этот доступ нужен.
   */
  private assertSkillPermission(
    policy: ToolPolicy,
    context: ToolCallContext,
  ): void {
    const required = policy.requiredPermission;

    if (required === null || context.skills.length === 0) {
      return;
    }

    const granted = context.skills.some(
      (skill) =>
        skill.permissions.includes(required) ||
        (required === 'shell' && skill.permissions.includes('network')),
    );

    if (!granted) {
      throw new PolicyViolation(
        POLICY_VIOLATION.PERMISSION_DENIED,
        `ни один навык не объявил разрешение ${required}`,
      );
    }
  }

  /** Структурный анализ кода для shell-инструментов. */
  private analyzeToolShell(
    policy: ToolPolicy,
    args: Record<string, unknown>,
  ): ShellAnalysis {
    const argName = policy.shell === 'exec' ? 'command' : 'code';
    const code = args[argName];

    if (typeof code !== 'string') {
      throw new PolicyViolation(
        POLICY_VIOLATION.SCHEMA_INVALID,
        `${argName}:expected string`,
      );
    }

    const allowlist =
      policy.shell === 'exec'
        ? EXEC_COMMAND_ALLOWLIST
        : SANDBOX_COMMAND_ALLOWLIST;

    const analysis = analyzeShell(code, { allowlist });

    if (analysis.violations.length > 0) {
      const detail = analysis.violations
        .map((violation) => violation.code)
        .join(', ');

      throw new PolicyViolation(POLICY_VIOLATION.COMMAND_DENIED, detail);
    }

    return analysis;
  }

  /**
   * Обрабатывает tainted-секреты: каналы эксфильтрации блокируются, поиск
   * маскирует значения. Возвращает санитизированные аргументы.
   */
  private applyTaint(
    policy: ToolPolicy,
    args: Record<string, unknown>,
    taintedSecrets: readonly string[],
  ): { args: Record<string, unknown>; detected: boolean; masked: boolean } {
    if (!containsSecretValue(args, taintedSecrets)) {
      return { args, detected: false, masked: false };
    }

    if (policy.taint === 'block') {
      throw new PolicyViolation(
        POLICY_VIOLATION.TAINT_BLOCKED,
        'аргументы содержат секрет из недоверенного источника',
      );
    }

    if (policy.taint === 'mask') {
      const masked = maskSecretValues(args, taintedSecrets);

      return {
        args: masked.value as Record<string, unknown>,
        detected: true,
        masked: masked.masked,
      };
    }

    return { args, detected: true, masked: false };
  }

  /**
   * Асинхронная (fire-and-forget) запись блокировки в append-only AuditLog.
   * Ошибка записи только логируется: аудит не должен менять решение политики.
   * В metadata нет значений аргументов и секретов.
   */
  private recordBlockedCall(
    context: ToolCallContext,
    toolName: string,
    reason: PolicyViolationCode,
  ): void {
    const auditService = this.auditService;

    if (!auditService) {
      return;
    }

    void auditService
      .record({
        userId: context.userId,
        action: 'agent_gateway.blocked',
        entityType: 'ToolCall',
        entityId: toolName,
        metadata: { userId: context.userId, toolName, reason },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Не удалось записать аудит блокировки ${toolName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}

/** Объединённый egress_allowlist навыков с разрешением `network`. */
function collectEgressAllowlist(
  skills: readonly ToolSkillContext[],
): readonly string[] {
  const domains: string[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    if (!skill.permissions.includes('network')) {
      continue;
    }

    for (const domain of skill.egressAllowlist) {
      const normalized = domain.trim().toLowerCase();

      if (normalized === '' || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      domains.push(normalized);
    }
  }

  return domains;
}

/** Есть ли среди навыков хотя бы один с разрешением `network`. */
function hasNetworkPermission(skills: readonly ToolSkillContext[]): boolean {
  return skills.some((skill) => skill.permissions.includes('network'));
}
