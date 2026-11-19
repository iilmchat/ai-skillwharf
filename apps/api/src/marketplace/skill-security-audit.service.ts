import { Injectable } from '@nestjs/common';
import type { SkillManifest } from '@skillwharf/shared';
import {
  type AuditFinding,
  type SkillAuditReport,
  skillAuditReportSchema,
} from './skill-audit.schemas.js';

/** Приватные адреса/сети, запрещённые в egress-политике навыка. */
const PRIVATE_EGRESS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['127.0.0.1', /127\.0\.0\.1/],
  ['localhost', /\blocalhost\b/i],
  ['10.0.0.0/8', /\b10(?:\.\d{1,3}){3}\b/],
  ['192.168.0.0/16', /\b192\.168(?:\.\d{1,3}){2}\b/],
];

/** Опасные системные команды и пути в теле SKILL.md. */
const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<
  readonly [string, string, RegExp]
> = [
  [
    'DANGEROUS_RM_RF',
    'rm -rf /',
    /rm\s+-rf\s+\/(?:\s|$)/i,
  ],
  ['DANGEROUS_MKFS', 'mkfs', /\bmkfs\b/i],
  ['DANGEROUS_DD', 'dd if=', /\bdd\s+if=/i],
  ['DANGEROUS_ETC_SHADOW', '/etc/shadow', /\/etc\/shadow/i],
  ['DANGEROUS_DOTENV', '.env', /\.env\b/i],
];

const WIDE_EGRESS_THRESHOLD = 5;

/**
 * Детерминированный статический аудит SKILL.md (DEVPORTAL-36.1/36.2).
 *
 * Никаких внешних вызовов и LLM: только манифест и текст, поэтому результат
 * воспроизводим. Критические находки блокируют публикацию, предупреждения
 * пропускаются с пометкой `warning`.
 */
@Injectable()
export class SkillSecurityAuditService {
  audit(
    manifest: SkillManifest,
    body: string,
    manifestYaml = '',
  ): SkillAuditReport {
    const findings = new Map<string, AuditFinding>();
    const add = (code: string, finding: AuditFinding): void => {
      if (!findings.has(code)) {
        findings.set(code, finding);
      }
    };
    const allowlist = manifest.egress_allowlist ?? [];
    // egress IP не проходят Zod-валидацию манифеста (только FQDN), поэтому
    // дополнительно сканируем исходный YAML, чтобы не потерять такую находку.
    const raw = `${manifestYaml}\n${body}`;

    if (/169\.254\.169\.254/.test(raw)) {
      add('CRITICAL_CLOUD_METADATA', {
        severity: 'critical',
        code: 'CRITICAL_CLOUD_METADATA',
        message: 'Обнаружено обращение к cloud metadata (169.254.169.254)',
      });
    }

    for (const [address, pattern] of PRIVATE_EGRESS_PATTERNS) {
      if (
        allowlist.some((domain) => pattern.test(domain)) ||
        pattern.test(raw)
      ) {
        add('CRITICAL_PRIVATE_EGRESS', {
          severity: 'critical',
          code: 'CRITICAL_PRIVATE_EGRESS',
          message: `Egress-политика содержит приватный адрес: ${address}`,
        });
      }
    }

    for (const [code, command, pattern] of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(raw)) {
        add(code, {
          severity: 'critical',
          code,
          message: `Обнаружена опасная конструкция: ${command}`,
        });
      }
    }

    if (manifest.signature === undefined || manifest.signature.trim() === '') {
      add('WARNING_UNSIGNED_SKILL', {
        severity: 'warning',
        code: 'WARNING_UNSIGNED_SKILL',
        message: 'Навык не имеет криптографической подписи Ed25519',
      });
    }

    if (/filesystem\s*:\s*write/i.test(raw)) {
      add('WARNING_BROAD_FILESYSTEM_PERMISSION', {
        severity: 'warning',
        code: 'WARNING_BROAD_FILESYSTEM_PERMISSION',
        message: 'Запрошена широкая запись в файловую систему (filesystem:write)',
      });
    }

    if (allowlist.length > WIDE_EGRESS_THRESHOLD) {
      add('WARNING_WIDE_EGRESS_ALLOWLIST', {
        severity: 'warning',
        code: 'WARNING_WIDE_EGRESS_ALLOWLIST',
        message: `Egress-allowlist содержит ${allowlist.length} доменов (более ${WIDE_EGRESS_THRESHOLD})`,
      });
    }

    const list = [...findings.values()];
    const status = list.some((item) => item.severity === 'critical')
      ? 'rejected'
      : list.some((item) => item.severity === 'warning')
        ? 'warning'
        : 'passed';

    return skillAuditReportSchema.parse({
      status,
      findings: list,
      checkedAt: new Date().toISOString(),
    });
  }
}
