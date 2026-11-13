import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSecurityOpts,
  FORBIDDEN_SYSCALLS,
  loadSeccompProfile,
  validateSeccompProfile,
  type SeccompProfile,
} from './seccomp.js';

const PROFILE_PATH = fileURLToPath(
  new URL('../../../sandbox/seccomp-profile.json', import.meta.url),
);

function readProfile(): SeccompProfile {
  return validateSeccompProfile(
    JSON.parse(readFileSync(PROFILE_PATH, 'utf8')),
  );
}

function allowedSyscalls(profile: SeccompProfile): Set<string> {
  return new Set(
    profile.syscalls
      .filter((rule) => rule.action === 'SCMP_ACT_ALLOW')
      .flatMap((rule) => rule.names),
  );
}

describe('sandbox seccomp profile', () => {
  it('валиден и работает в режиме deny by default', () => {
    const profile = readProfile();

    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(profile.architectures).toContain('SCMP_ARCH_X86_64');
    expect(profile.syscalls.length).toBeGreaterThan(0);
  });

  it('явно запрещает все опасные сисколлы', () => {
    const profile = readProfile();
    const denied = new Set(
      profile.syscalls
        .filter((rule) => rule.action === 'SCMP_ACT_ERRNO')
        .flatMap((rule) => rule.names),
    );

    for (const name of FORBIDDEN_SYSCALLS) {
      expect(denied.has(name), `нет явного запрета ${name}`).toBe(true);
    }
  });

  it('оставляет сисколлы, необходимые Node.js, Python и CLI-утилитам', () => {
    const allowed = allowedSyscalls(readProfile());
    const required = [
      'execve',
      'clone',
      'fork',
      'mmap',
      'mprotect',
      'madvise',
      'futex',
      'rseq',
      'membarrier',
      'eventfd2',
      'epoll_wait',
      'timerfd_create',
      'openat',
      'statx',
      'getrandom',
      'arch_prctl',
      'socket',
      'connect',
      'sendto',
      'recvfrom',
      'ioctl',
    ];

    for (const name of required) {
      expect(allowed.has(name), `не разрешён ${name}`).toBe(true);
    }
  });

  it('фильтрует namespace-флаги clone', () => {
    const profile = readProfile();
    const cloneRule = profile.syscalls.find(
      (rule) =>
        rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes('clone'),
    );

    expect(cloneRule?.args?.[0]).toMatchObject({
      index: 0,
      op: 'SCMP_CMP_MASKED_EQ',
      value: 2114060288,
      valueTwo: 0,
    });
  });

  it('отклоняет профиль, который разрешает запрещённый сисколл', () => {
    const profile = readProfile();
    const unsafeProfile = {
      ...profile,
      syscalls: [
        ...profile.syscalls,
        { names: ['ptrace'], action: 'SCMP_ACT_ALLOW' },
      ],
    };

    expect(() => validateSeccompProfile(unsafeProfile)).toThrow(/ptrace/);
  });

  it('отклоняет clone без маски namespace-флагов', () => {
    const profile = readProfile();
    const unsafeProfile = {
      ...profile,
      syscalls: profile.syscalls.map((rule) =>
        rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes('clone')
          ? { ...rule, args: [] }
          : rule,
      ),
    };

    expect(() => validateSeccompProfile(unsafeProfile)).toThrow(/clone/);
  });

  it('отклоняет профиль без явного запрета опасного сисколла', () => {
    const profile = readProfile();
    const unsafeProfile = {
      ...profile,
      syscalls: profile.syscalls.map((rule) => ({
        ...rule,
        names: rule.names.filter((name) => name !== 'ptrace'),
      })),
    };

    expect(() => validateSeccompProfile(unsafeProfile)).toThrow(/ptrace/);
  });
});

describe('loadSeccompProfile', () => {
  it('возвращает undefined, если feature flag не задан', () => {
    expect(loadSeccompProfile(undefined)).toBeUndefined();
    expect(loadSeccompProfile('')).toBeUndefined();
    expect(loadSeccompProfile('   ')).toBeUndefined();
  });

  it('читает валидный профиль и отдаёт compact JSON', () => {
    const loaded = loadSeccompProfile(PROFILE_PATH);

    expect(loaded).toBeDefined();
    expect(loaded?.path).toBe(PROFILE_PATH);
    expect(JSON.parse(loaded?.inlineJson ?? '{}')).toMatchObject({
      defaultAction: 'SCMP_ACT_ERRNO',
    });
  });

  it('падает, если файл профиля не найден', () => {
    const missingPath = fileURLToPath(
      new URL('./missing-seccomp-profile.json', import.meta.url),
    );

    expect(() => loadSeccompProfile(missingPath)).toThrow(
      /не удалось прочитать/,
    );
  });
});

describe('buildSecurityOpts', () => {
  it('без профиля сохраняет прежнее поведение', () => {
    expect(buildSecurityOpts(undefined)).toEqual(['no-new-privileges:true']);
  });

  it('добавляет seccomp как inline JSON, а не путь к файлу', () => {
    const securityOpts = buildSecurityOpts(loadSeccompProfile(PROFILE_PATH));

    expect(securityOpts).toHaveLength(2);
    expect(securityOpts[0]).toBe('no-new-privileges:true');
    expect(securityOpts[1].startsWith('seccomp={')).toBe(true);
    expect(
      JSON.parse(securityOpts[1].slice('seccomp='.length)),
    ).toMatchObject({
      defaultAction: 'SCMP_ACT_ERRNO',
    });
  });
});
