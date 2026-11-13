import type { SkillPermission } from '@skillwharf/shared';

/**
 * Контракт декларативного policy engine Agent Gateway (ADR 0004).
 *
 * Gateway получает контекст вызова (пользователь, роль, включённые навыки и
 * значения, «загрязнённые» недоверенными источниками) и возвращает решение:
 * санитизированные аргументы, сетевое намерение и признак taint. Любая
 * неопределённость трактуется как запрет (deny by default).
 */

/** Роль пользователя в иерархии доступа Gateway. */
export type UserRole = 'guest' | 'user' | 'admin' | 'owner';

/** Включённый навык, объявивший вызываемый инструмент. */
export interface ToolSkillContext {
  name: string;
  permissions: readonly SkillPermission[];
  egressAllowlist: readonly string[];
}

/** Контекст одного вызова инструмента моделью. */
export interface ToolCallContext {
  userId: string;
  role: UserRole;
  /** Включённые навыки, объявившие инструмент. */
  skills: readonly ToolSkillContext[];
  /** Секрето-подобные значения из недоверенных источников. */
  taintedSecrets: readonly string[];
}

/** Решение по сетевому доступу вызова. */
export interface EgressDecision {
  /** Код/команда пытается выйти в сеть. */
  requested: boolean;
  /** FQDN из навыков; пусто => сеть запрещена. */
  allowlist: readonly string[];
}

/** Итоговое решение policy engine по вызову инструмента. */
export interface PolicyDecision {
  toolName: string;
  /** Санитизированные аргументы для инструмента. */
  args: Record<string, unknown>;
  egress: EgressDecision;
  taint: { detected: boolean; masked: boolean };
}
