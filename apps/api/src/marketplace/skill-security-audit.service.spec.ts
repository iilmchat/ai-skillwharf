import { skillManifestSchema, type SkillManifest } from '@skillwharf/shared';
import { describe, expect, it } from 'vitest';
import { skillAuditReportSchema } from './skill-audit.schemas.js';
import { SkillSecurityAuditService } from './skill-security-audit.service.js';

const BASE_MANIFEST = {
  name: 'ozon-helper',
  version: '1.0.0',
  description: 'Помощник маркетплейса',
  author: { name: 'Ivan' },
  permissions: ['network'],
  signature: 'ed25519:YWJjZA==',
} satisfies Parameters<typeof skillManifestSchema.parse>[0];

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return skillManifestSchema.parse({ ...BASE_MANIFEST, ...overrides });
}

describe('SkillSecurityAuditService (DEVPORTAL-36.1/36.2)', () => {
  const audit = new SkillSecurityAuditService();

  it('блокирует доступ к cloud metadata (169.254.169.254)', () => {
    const report = audit.audit(
      manifest(),
      'Сначала запросим http://169.254.169.254/latest/meta-data/',
    );

    expect(report.status).toBe('rejected');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'critical',
          code: 'CRITICAL_CLOUD_METADATA',
        }),
      ]),
    );
    expect(skillAuditReportSchema.safeParse(report).success).toBe(true);
  });

  it('блокирует rm -rf / и другие опасные команды', () => {
    const report = audit.audit(manifest(), 'docker exec ... rm -rf / && echo ok');

    expect(report.status).toBe('rejected');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'DANGEROUS_RM_RF',
    );
    expect(
      audit.audit(manifest(), 'dd if=/dev/zero of=/dev/sda').findings,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DANGEROUS_DD', severity: 'critical' }),
      ]),
    );
  });

  it('находит приватные сети в исходном YAML egress_allowlist', () => {
    const report = audit.audit(
      manifest(),
      'Безопасный навык',
      'egress_allowlist:\n  - 127.0.0.1\n  - localhost',
    );

    expect(report.status).toBe('rejected');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CRITICAL_PRIVATE_EGRESS' }),
      ]),
    );
  });

  it('предупреждает об отсутствии подписи Ed25519', () => {
    const unsigned = skillManifestSchema.parse({
      ...BASE_MANIFEST,
      signature: undefined,
    });
    const report = audit.audit(unsigned, 'Обычный навык');

    expect(report.status).toBe('warning');
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'WARNING_UNSIGNED_SKILL',
        }),
      ]),
    );
  });

  it('предупреждает о filesystem:write и широком egress-списке', () => {
    const wide = manifest({
      egress_allowlist: [
        'a.example.com',
        'b.example.com',
        'c.example.com',
        'd.example.com',
        'e.example.com',
        'f.example.com',
      ],
    });
    const report = audit.audit(wide, 'permissions: filesystem:write');

    expect(report.status).toBe('warning');
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'WARNING_BROAD_FILESYSTEM_PERMISSION',
        'WARNING_WIDE_EGRESS_ALLOWLIST',
      ]),
    );
  });

  it('пропускает чистый подписанный навык без находок', () => {
    const report = audit.audit(manifest(), '# Описание\nПростой навык.');

    expect(report.status).toBe('passed');
    expect(report.findings).toEqual([]);
    expect(new Date(report.checkedAt).toString()).not.toBe('Invalid Date');
  });
});
