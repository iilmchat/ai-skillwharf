import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import {
  firecrackerConfigSchema,
  type FirecrackerConfig,
  type ISandboxRuntimeProvider,
  type SandboxExecutionRequest,
  type SandboxResult,
} from './sandbox-runtime-provider.js';

/**
 * Опциональный провайтер microVM (Sprint 25 / INFRA-25.1, ADR 0002).
 *
 * Активируется ТОЛЬКО явным `SANDBOX_RUNTIME=firecracker`. Отсутствие
 * `/dev/kvm` или бинарника — ошибка конструктора (fail closed): мы никогда не
 * падаем обратно на Docker молча, если администратор явно выбрал Firecracker.
 */

export const FIRECRACKER_KVM_PATH = '/dev/kvm';

/** Тело `PUT /boot-source`. */
export const firecrackerBootSourceSchema = z.object({
  kernel_image_path: z.string().min(1),
  boot_args: z.string().max(4096),
});

/** Тело `PUT /drives/{drive_id}`. RootFS — только для чтения. */
export const firecrackerDriveSchema = z.object({
  drive_id: z.string().min(1),
  path_on_host: z.string().min(1),
  is_root_device: z.boolean(),
  is_read_only: z.boolean(),
});

/** Тело `PUT /machine-config`. */
export const firecrackerMachineConfigSchema = z.object({
  vcpu_count: z.number().int().positive(),
  mem_size_mib: z.number().int().positive(),
});

/** Тело `PUT /actions`. */
export const firecrackerActionSchema = z.object({
  action_type: z.literal('InstanceStart'),
});

export type FirecrackerBootSource = z.infer<typeof firecrackerBootSourceSchema>;
export type FirecrackerDrive = z.infer<typeof firecrackerDriveSchema>;
export type FirecrackerMachineConfig = z.infer<typeof firecrackerMachineConfigSchema>;
export type FirecrackerAction = z.infer<typeof firecrackerActionSchema>;

export interface FirecrackerVmConfig {
  readonly bootSource: FirecrackerBootSource;
  /** Первый drive — rootfs (read-only), второй — файл с кодом задачи. */
  readonly drives: readonly FirecrackerDrive[];
  readonly machineConfig: FirecrackerMachineConfig;
  readonly action: FirecrackerAction;
}

/**
 * Собирает конфигурацию microVM. Код задачи пишется в отдельный read-only
 * drive (сырой файл), а не в cmdline: boot-аргументы ограничены 4096 байт,
 * а payload песочницы — до 256 КБ. RootFS остаётся read-only, как требуется.
 */
export function buildFirecrackerVmConfig(
  config: FirecrackerConfig,
  request: SandboxExecutionRequest,
  codePath: string,
): FirecrackerVmConfig {
  firecrackerConfigSchema.parse(config);

  return {
    bootSource: firecrackerBootSourceSchema.parse({
      kernel_image_path: config.kernelImage,
      boot_args: 'console=ttyS0 reboot=k panic=1 pci=off sandbox.code_device=/dev/vdb',
    }),
    drives: [
      firecrackerDriveSchema.parse({
        drive_id: 'rootfs',
        path_on_host: config.rootfsImage,
        is_root_device: true,
        is_read_only: true,
      }),
      firecrackerDriveSchema.parse({
        drive_id: 'code',
        path_on_host: codePath,
        is_root_device: false,
        is_read_only: true,
      }),
    ],
    machineConfig: firecrackerMachineConfigSchema.parse({
      vcpu_count: config.vcpuCount,
      mem_size_mib: config.memSizeMib,
    }),
    action: firecrackerActionSchema.parse({ action_type: 'InstanceStart' }),
  };
}

/** Минимальный HTTP-клиент к Firecracker API socket. */
export interface FirecrackerApiClient {
  put(path: string, body: unknown): Promise<void>;
}

export interface FirecrackerVmHandle {
  configure(config: FirecrackerVmConfig): Promise<void>;
  waitForCompletion(timeoutMs: number): Promise<SandboxResult>;
  stop(): void;
}

export interface FirecrackerVmLauncher {
  launch(socketPath: string, codePath: string): Promise<FirecrackerVmHandle>;
}

export interface FirecrackerProviderDependencies {
  /** DI точки присутствия /dev/kvm и бинарника (в тестах — фейк). */
  readonly exists?: (path: string) => boolean;
  /** DI запуска microVM (в тестах — фейк без KVM). */
  readonly launcher?: FirecrackerVmLauncher;
}

interface LauncherDependencies {
  readonly spawn?: typeof spawnChild;
  readonly exists?: (path: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly apiClientFactory?: (socketPath: string) => FirecrackerApiClient;
}

const httpStatusSchema = z.number().int().min(100).max(599);

/** Реальный клиент: PUT JSON по unix-socket `--api-sock`. */
export class UnixSocketFirecrackerApiClient implements FirecrackerApiClient {
  constructor(private readonly socketPath: string) {}

  put(path: string, body: unknown): Promise<void> {
    const payload = JSON.stringify(body);

    return new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          method: 'PUT',
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            const status = httpStatusSchema.safeParse(response.statusCode);

            if (!status.success || status.data >= 300) {
              reject(new Error(`Firecracker API ${path}: HTTP ${String(response.statusCode)}`));
              return;
            }

            resolve();
          });
        },
      );
      req.once('error', reject);
      req.end(payload);
    });
  }
}

class ProcessFirecrackerVmLauncher implements FirecrackerVmLauncher {
  private readonly spawnFn: typeof spawnChild;
  private readonly exists: (path: string) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiClientFactory: (socketPath: string) => FirecrackerApiClient;

  constructor(
    private readonly config: FirecrackerConfig,
    dependencies: LauncherDependencies = {},
  ) {
    this.spawnFn = dependencies.spawn ?? spawnChild;
    this.exists = dependencies.exists ?? existsSync;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiClientFactory = dependencies.apiClientFactory ?? ((socketPath) => new UnixSocketFirecrackerApiClient(socketPath));
  }

  async launch(socketPath: string, _codePath: string): Promise<FirecrackerVmHandle> {
    const child = this.spawnFn(this.config.bin, ['--api-sock', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const api = this.apiClientFactory(socketPath);
    const deadline = Date.now() + this.config.timeoutMs;

    while (!this.exists(socketPath)) {
      if (Date.now() >= deadline || child.exitCode !== null) {
        child.kill('SIGKILL');
        throw new Error('Firecracker не создал API socket вовремя');
      }

      await this.sleep(10);
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    return {
      configure: async (vmConfig) => {
        await api.put('/boot-source', vmConfig.bootSource);

        for (const drive of vmConfig.drives) {
          await api.put(`/drives/${drive.drive_id}`, drive);
        }

        await api.put('/machine-config', vmConfig.machineConfig);
        await api.put('/actions', vmConfig.action);
      },
      waitForCompletion: (timeoutMs) =>
        new Promise<SandboxResult>((resolve) => {
          let settled = false;
          let timedOut = false;
          const finish = (): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, timedOut });
          };
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
            finish();
          }, timeoutMs);
          child.once('exit', finish);
          child.once('error', finish);
        }),
      stop: () => {
        child.kill('SIGKILL');
      },
    };
  }
}

export class FirecrackerSandboxProvider implements ISandboxRuntimeProvider {
  private readonly config: FirecrackerConfig;
  private readonly exists: (path: string) => boolean;
  private readonly launcher: FirecrackerVmLauncher;

  constructor(
    config: FirecrackerConfig,
    dependencies: FirecrackerProviderDependencies = {},
  ) {
    this.config = firecrackerConfigSchema.parse(config);
    this.exists = dependencies.exists ?? existsSync;
    this.launcher =
      dependencies.launcher ?? new ProcessFirecrackerVmLauncher(this.config);

    if (!this.isAvailable()) {
      throw new Error(
        `Firecracker недоступен: нужны ${FIRECRACKER_KVM_PATH} и бинарник ${this.config.bin}; ` +
          'используйте SANDBOX_RUNTIME=docker для окружений без KVM',
      );
    }
  }

  /** Синхронная проверка — используется в конструкторе для fail closed. */
  private isAvailable(): boolean {
    return this.exists(FIRECRACKER_KVM_PATH) && this.exists(this.config.bin);
  }

  async healthCheck(): Promise<boolean> {
    return this.isAvailable();
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxResult> {
    const workDir = await mkdtemp(join(this.config.apiSocketDir, 'skillwharf-fc-'));

    try {
      const codePath = join(workDir, 'code');
      await writeFile(codePath, request.code, 'utf8');

      const handle = await this.launcher.launch(join(workDir, 'api.sock'), codePath);

      try {
        await handle.configure(
          buildFirecrackerVmConfig(this.config, request, codePath),
        );

        return await handle.waitForCompletion(request.timeoutMs);
      } finally {
        handle.stop();
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
