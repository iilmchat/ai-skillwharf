import { Test, TestingModule } from '@nestjs/testing';
import { SandboxController } from './sandbox.controller.js';
import { SandboxService } from './sandbox.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface SandboxMock {
  runCommand: MockFn;
}

describe('SandboxController', () => {
  let controller: SandboxController;
  let sandbox: SandboxMock;

  beforeEach(async () => {
    sandbox = { runCommand: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SandboxController],
      providers: [{ provide: SandboxService, useValue: sandbox }],
    }).compile();

    controller = moduleRef.get(SandboxController);
  });

  it('выполняет код через SandboxService и возвращает stdout', async () => {
    sandbox.runCommand.mockResolvedValue('hello\n');

    await expect(controller.execute({ code: 'echo hello' })).resolves.toEqual({
      stdout: 'hello\n',
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith('echo hello');
  });

  it('пробрасывает ошибку песочницы', async () => {
    sandbox.runCommand.mockRejectedValue(new Error('timeout'));

    await expect(controller.execute({ code: 'sleep 100' })).rejects.toThrow(
      'timeout',
    );
  });
});
