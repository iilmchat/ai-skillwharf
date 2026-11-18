import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFirecrackerVmConfig,
  FirecrackerSandboxProvider,
  type FirecrackerVmConfig,
  type FirecrackerVmHandle,
} from './firecracker-sandbox-provider.js';
import type { FirecrackerConfig } from './sandbox-runtime-provider.js';

const CONFIG: FirecrackerConfig = {
  bin: '/usr/bin/firecracker',
  kernelImage: '/opt/firecracker/vmlinux',
  rootfsImage: '/opt/firecracker/rootfs.ext4',
  vcpuCount: 2,
  memSizeMib: 256,
  apiSocketDir: tmpdir(),
  timeoutMs: 1_000,
};

const REQUEST = {
  code: 'echo firecracker',
  env: {},
  network: 'none' as const,
  egressAllowlist: [],
  timeoutMs: 1_000,
  memoryLimitBytes: 128 * 1024 * 1024,
  nanoCpus: 500_000_000,
};

describe('конфигурация microVM', () => {
  it('boot-source/drives/machine-config/action валидируются и заданы', () => {
    const vm = buildFirecrackerVmConfig(CONFIG, REQUEST, '/tmp/code');

    expect(vm.bootSource.kernel_image_path).toBe(CONFIG.kernelImage);
    expect(vm.bootSource.boot_args).toContain('console=ttyS0');
    expect(vm.machineConfig).toEqual({ vcpu_count: 2, mem_size_mib: 256 });
    expect(vm.action).toEqual({ action_type: 'InstanceStart' });
  });

  it('rootfs подключается read-only, код — отдельным read-only drive', () => {
    const vm = buildFirecrackerVmConfig(CONFIG, REQUEST, '/tmp/code');

    expect(vm.drives).toHaveLength(2);
    expect(vm.drives[0]).toEqual({
      drive_id: 'rootfs',
      path_on_host: CONFIG.rootfsImage,
      is_root_device: true,
      is_read_only: true,
    });
    expect(vm.drives[1]).toEqual({
      drive_id: 'code',
      path_on_host: '/tmp/code',
      is_root_device: false,
      is_read_only: true,
    });
  });

  it('невалидная конфигурация отклоняется Zod', () => {
    expect(() =>
      buildFirecrackerVmConfig({ ...CONFIG, vcpuCount: 0 }, REQUEST, '/tmp/code'),
    ).toThrow();
  });
});

describe('FirecrackerSandboxProvider', () => {
  it('fail closed без /dev/kvm', () => {
    expect(
      () =>
        new FirecrackerSandboxProvider(CONFIG, {
          exists: (path) => path !== '/dev/kvm',
        }),
    ).toThrow(/Firecracker недоступен/);
  });

  it('healthCheck зависит от KVM и бинарника', async () => {
    const healthy = new FirecrackerSandboxProvider(CONFIG, {
      exists: () => true,
    });

    await expect(healthy.healthCheck()).resolves.toBe(true);
  });

  it('execute конфигурирует API, ждёт результат и останавливает VM', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'fc-provider-'));
    const config = { ...CONFIG, apiSocketDir: workDir };
    let captured: FirecrackerVmConfig | undefined;
    const handle: FirecrackerVmHandle = {
      configure: async (vm) => {
        captured = vm;
      },
      waitForCompletion: async () => ({ stdout: 'ok', stderr: '', timedOut: false }),
      stop: () => undefined,
    };
    const stop = vi.spyOn(handle, 'stop');
    const launch = vi.fn(async () => handle);
    const provider = new FirecrackerSandboxProvider(config, {
      exists: () => true,
      launcher: { launch },
    });

    await expect(provider.execute(REQUEST)).resolves.toEqual({
      stdout: 'ok',
      stderr: '',
      timedOut: false,
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(captured?.machineConfig).toEqual({ vcpu_count: 2, mem_size_mib: 256 });
    expect(stop).toHaveBeenCalledTimes(1);

    await rm(workDir, { recursive: true, force: true });
  });
});
