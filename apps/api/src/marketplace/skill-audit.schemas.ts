import { z } from 'zod';

/** Уровень находки статического аудита SKILL.md. */
export const auditSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

export const auditFindingSchema = z
  .object({
    severity: auditSeveritySchema,
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type AuditFinding = z.infer<typeof auditFindingSchema>;

export const auditStatusSchema = z.enum(['passed', 'warning', 'rejected']);
export type AuditStatus = z.infer<typeof auditStatusSchema>;

/** Отчёт аудита: rejected блокирует публикацию, warning — с пометкой. */
export const skillAuditReportSchema = z
  .object({
    status: auditStatusSchema,
    findings: z.array(auditFindingSchema),
    checkedAt: z.string(),
  })
  .strict();
export type SkillAuditReport = z.infer<typeof skillAuditReportSchema>;
