import { DockerSandboxProvider } from './docker-sandbox-provider.js';
import { FirecrackerSandboxProvider } from './firecracker-sandbox-provider.js';
import { createSandboxRuntimeProvider } from './provider-factory.js';

const FIRECRACKER_ENV = {
  SANDBOX_RUNTIME: 'firecracker',
  FIRECRACKER_BIN: '/usr/bin/firecracker',
  FIRECRACKER_KERNEL_IMAGE: '/opt/firecracker/vmlinux',
  FIRECRACKER_ROOTFS_IMAGE: '/opt/firecracker/rootfs.ext4',
};

describe('выбор рантайма по SANDBOX_RUNTIME', () => {
  it('без переменной используется Docker (прежнее поведение)', () => {
    expect(createSandboxRuntimeProvider({ env: {} })).toBeInstanceOf(
      DockerSandboxProvider,
    );
  });

  it('явный docker тоже использует DockerSandboxProvider', () => {
    expect(
      createSandboxRuntimeProvider({ env: { SANDBOX_RUNTIME: 'docker' } }),
    ).toBeInstanceOf(DockerSandboxProvider);
  });

  it('firecracker активируется только явным значением', () => {
    expect(
      createSandboxRuntimeProvider({
        env: FIRECRACKER_ENV,
        firecrackerDependencies: { exists: () => true },
      }),
    ).toBeInstanceOf(FirecrackerSandboxProvider);
  });

  it('firecracker без /dev/kvm — fail closed, без фолбэка на Docker', () => {
    expect(() =>
      createSandboxRuntimeProvider({
        env: FIRECRACKER_ENV,
        firecrackerDependencies: {
          exists: (path) => path !== '/dev/kvm',
        },
      }),
    ).toThrow(/Firecracker недоступен/);
  });

  it('firecracker без бинарника — fail closed', () => {
    expect(() =>
      createSandboxRuntimeProvider({
        env: FIRECRACKER_ENV,
        firecrackerDependencies: {
          exists: (path) => path !== FIRECRACKER_ENV.FIRECRACKER_BIN,
        },
      }),
    ).toThrow(/Firecracker недоступен/);
  });

  it('firecracker без kernel/rootfs — ошибка Zod-валидации', () => {
    expect(() =>
      createSandboxRuntimeProvider({
        env: { SANDBOX_RUNTIME: 'firecracker' },
        firecrackerDependencies: { exists: () => true },
      }),
    ).toThrow();
  });

  it('неизвестное значение SANDBOX_RUNTIME отвергается', () => {
    expect(() =>
      createSandboxRuntimeProvider({ env: { SANDBOX_RUNTIME: 'gvisor' } }),
    ).toThrow(/неизвестный рантайм/);
  });
});
