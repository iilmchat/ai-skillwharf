import { UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WorkspaceContextGuard } from '../workspaces/workspace-context.guard.js';
import { CorpChannelsController } from './corp-channels.controller.js';
import { CorpChannelsService } from './corp-channels.service.js';

const USER_ID = 'owner-1';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

type ControllerRequest = Parameters<CorpChannelsController['list']>[0];

function request(user?: { userId: string }): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

describe('CorpChannelsController (OMNI-40.1/40.2)', () => {
  let controller: CorpChannelsController;
  let channels: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    channels = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'channel-1' })),
      remove: vi.fn(async () => ({ id: 'channel-1' })),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CorpChannelsController],
      providers: [{ provide: CorpChannelsService, useValue: channels }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkspaceContextGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(CorpChannelsController);
  });

  it('список каналов воркспейса', async () => {
    await expect(controller.list(request({ userId: USER_ID }), WORKSPACE_ID)).resolves.toEqual([]);
    expect(channels.list).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
  });

  it('создаёт канал и передаёт тело сервису', async () => {
    const body = {
      provider: 'vk_teams',
      name: 'VK Teams Закупки',
      botToken: 'token',
    };

    await expect(
      controller.create(request({ userId: USER_ID }), WORKSPACE_ID, body),
    ).resolves.toEqual({ id: 'channel-1' });
    expect(channels.create).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, body);
  });

  it('удаляет канал', async () => {
    await expect(
      controller.remove(request({ userId: USER_ID }), WORKSPACE_ID, 'channel-1'),
    ).resolves.toEqual({ id: 'channel-1' });
    expect(channels.remove).toHaveBeenCalledWith(
      USER_ID,
      WORKSPACE_ID,
      'channel-1',
    );
  });

  it('отвергает неаутентифицированного пользователя', async () => {
    expect(() => controller.list(request(), WORKSPACE_ID)).toThrow(
      UnauthorizedException,
    );
    expect(channels.list).not.toHaveBeenCalled();
  });
});
