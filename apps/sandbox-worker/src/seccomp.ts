import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Сисколлы, которые нельзя разрешать sandbox-контейнерам. Список совпадает
 * с явными `SCMP_ACT_ERRNO`-правилами в `sandbox/seccomp-profile.json`.
 * Профиль по умолчанию и так запрещает всё, но явные правила и эта проверка
 * защищают от случайного расширения allowlist в будущем.
 */
export const FORBIDDEN_SYSCALLS = [
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'kcmp',
  'pidfd_getfd',
  'pidfd_open',
  'pidfd_send_signal',
  'mount',
  'umount2',
  'unshare',
  'setns',
  'pivot_root',
  'chroot',
  'bpf',
  'keyctl',
  'add_key',
  'request_key',
  'perf_event_open',
  'userfaultfd',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',
  'open_by_handle_at',
  'name_to_handle_at',
  'kexec_load',
  'kexec_file_load',
  'reboot',
  'swapon',
  'swapoff',
  'init_module',
  'finit_module',
  'delete_module',
  'create_module',
  'query_module',
  'get_kernel_syms',
  'personality',
  'iopl',
  'ioperm',
  'syslog',
  'acct',
  'quotactl',
  'settimeofday',
  'clock_settime',
  'clock_adjtime',
  'adjtimex',
  'sethostname',
  'setdomainname',
  'vhangup',
  'lookup_dcookie',
  'uselib',
] as const;

/** Маска namespace-флагов clone, которые нельзя разрешать даже для потоков. */
const CLONE_NAMESPACE_MASK = 2114060288;

const seccompActionSchema = z.enum([
  'SCMP_ACT_ALLOW',
  'SCMP_ACT_ERRNO',
  'SCMP_ACT_KILL',
  'SCMP_ACT_KILL_PROCESS',
  'SCMP_ACT_TRAP',
  'SCMP_ACT_LOG',
  'SCMP_ACT_NOTIFY',
]);

const seccompArgumentSchema = z.object({
  index: z.number().int().nonnegative(),
  value: z.number().int().optional(),
  valueTwo: z.number().int().optional(),
  op: z.enum([
    'SCMP_CMP_NE',
    'SCMP_CMP_LT',
    'SCMP_CMP_LE',
    'SCMP_CMP_EQ',
    'SCMP_CMP_GE',
    'SCMP_CMP_GT',
    'SCMP_CMP_MASKED_EQ',
  ]),
});

const seccompFilterSchema = z.object({
  caps: z.array(z.string()).optional(),
  arches: z.array(z.string()).optional(),
  minKernel: z.string().optional(),
});

const seccompSyscallSchema = z.object({
  names: z.array(z.string().min(1)).min(1),
  action: seccompActionSchema,
  args: z.array(seccompArgumentSchema).optional(),
  errnoRet: z.number().int().positive().optional(),
  comment: z.string().optional(),
  includes: seccompFilterSchema.optional(),
  excludes: seccompFilterSchema.optional(),
});

const seccompProfileSchema = z.object({
  defaultAction: z.literal('SCMP_ACT_ERRNO'),
  defaultErrnoRet: z.number().int().positive().optional(),
  architectures: z.array(z.string().min(1)).min(1),
  syscalls: z.array(seccompSyscallSchema).min(1),
});

export type SeccompProfile = z.infer<typeof seccompProfileSchema>;

export interface LoadedSeccompProfile {
  /** Путь, из которого прочитан профиль (для логов и диагностики). */
  readonly path: string;
  /** Профиль в виде compact JSON для Docker API / `--security-opt`. */
  readonly inlineJson: string;
  /** Количество правил (не сисколлов) в профиле. */
  readonly ruleCount: number;
}

/**
 * Проверяет структуру профиля и инварианты безопасности.
 * Бросает Error с человекочитаемым сообщением, если профиль небезопасен.
 */
export function validateSeccompProfile(value: unknown): SeccompProfile {
  const result = seccompProfileSchema.safeParse(value);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'profile'}: ${issue.message}`)
      .join('; ');
    throw new Error(`некорректный seccomp-профиль: ${details}`);
  }

  const profile = result.data;
  const forbidden = new Set<string>(FORBIDDEN_SYSCALLS);
  const explicitlyDenied = new Set<string>();

  for (const rule of profile.syscalls) {
    if (rule.action === 'SCMP_ACT_ALLOW') {
      const leaked = rule.names.filter((name) => forbidden.has(name));
      if (leaked.length > 0) {
        throw new Error(
          `seccomp-профиль разрешает запрещённые сисколлы: ${leaked.join(', ')}`,
        );
      }
    }

    if (rule.action === 'SCMP_ACT_ERRNO') {
      for (const name of rule.names) {
        if (forbidden.has(name)) {
          explicitlyDenied.add(name);
        }
      }
    }

    if (rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes('clone')) {
      const filtersNamespaceFlags = rule.args?.some(
        (argument) =>
          argument.index === 0 &&
          argument.op === 'SCMP_CMP_MASKED_EQ' &&
          argument.value === CLONE_NAMESPACE_MASK &&
          argument.valueTwo === 0,
      );

      if (!filtersNamespaceFlags) {
        throw new Error(
          'seccomp-профиль разрешает clone без маски namespace-флагов',
        );
      }
    }
  }

  const missingDenials = FORBIDDEN_SYSCALLS.filter(
    (name) => !explicitlyDenied.has(name),
  );

  if (missingDenials.length > 0) {
    throw new Error(
      `seccomp-профиль не содержит явного запрета: ${missingDenials.join(', ')}`,
    );
  }

  return profile;
}

/**
 * Читает и валидирует профиль. `undefined`/пустая строка означают, что
 * feature flag выключен: worker сохраняет прежнее поведение (профиль Docker
 * по умолчанию).
 *
 * Если путь задан, ошибка чтения или валидации пробрасывается: worker не
 * должен молча запускать контейнеры без профиля (fail closed).
 */
export function loadSeccompProfile(
  profilePath: string | undefined,
): LoadedSeccompProfile | undefined {
  const normalizedPath = profilePath?.trim();

  if (!normalizedPath) {
    return undefined;
  }

  let rawProfile: string;
  try {
    rawProfile = readFileSync(normalizedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `не удалось прочитать seccomp-профиль ${normalizedPath}: ${message}`,
    );
  }

  let parsedProfile: unknown;
  try {
    parsedProfile = JSON.parse(rawProfile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `seccomp-профиль ${normalizedPath} не является валидным JSON: ${message}`,
    );
  }

  const profile = validateSeccompProfile(parsedProfile);

  return {
    path: normalizedPath,
    inlineJson: JSON.stringify(profile),
    ruleCount: profile.syscalls.length,
  };
}

/**
 * Docker принимает профиль как inline JSON в `SecurityOpt`. Передавать путь к
 * файлу нельзя: worker читает файл внутри своего контейнера, а демон Docker
 * видит файловую систему хоста.
 */
export function buildSecurityOpts(
  profile: LoadedSeccompProfile | undefined,
): string[] {
  const securityOpts = ['no-new-privileges:true'];

  if (profile) {
    securityOpts.push(`seccomp=${profile.inlineJson}`);
  }

  return securityOpts;
}
