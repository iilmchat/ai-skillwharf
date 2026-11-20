import { UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SchedulesController } from './schedules.controller.js';
import { ScheduledJobsService } from './scheduled-jobs.service.js';

const USER_ID = 'user-1';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const JOB_ID = 'job-1';

type ControllerRequest = Parameters<SchedulesController['list']>[0];

function request(user?: { userId: string }): ControllerRequest {
  return { user } as unknown as ControllerRequest;
}

describe('SchedulesController (CRON-43.1/43.2)', () => {
  let controller: SchedulesController;
  let jobs: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    runNow: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    jobs = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: JOB_ID })),
      update: vi.fn(async () => ({ id: JOB_ID, isActive: false })),
      remove: vi.fn(async () => ({ id: JOB_ID })),
      runNow: vi.fn(async () => ({
        jobId: JOB_ID,
        status: 'completed',
        summary: 'готово',
        nextRunAt: '2026-11-20T05:15:00.000Z',
      })),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SchedulesController],
      providers: [{ provide: ScheduledJobsService, useValue: jobs }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(SchedulesController);
  });

  it('CRUD расписаний', async () => {
    await controller.list(request({ userId: USER_ID }), WORKSPACE_ID);
    await controller.create(request({ userId: USER_ID }), WORKSPACE_ID, {});
    await controller.update(
      request({ userId: USER_ID }),
      WORKSPACE_ID,
      JOB_ID,
      { isActive: false },
    );
    await controller.remove(request({ userId: USER_ID }), WORKSPACE_ID, JOB_ID);

    expect(jobs.list).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
    expect(jobs.create).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, {});
    expect(jobs.update).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, JOB_ID, {
      isActive: false,
    });
    expect(jobs.remove).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, JOB_ID);
  });

  it('run-now возвращает результат запуска с доставкой', async () => {
    const result = await controller.runNow(
      request({ userId: USER_ID }),
      WORKSPACE_ID,
      JOB_ID,
    );

    expect(result).toMatchObject({ status: 'completed', summary: 'готово' });
    expect(jobs.runNow).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, JOB_ID);
  });

  it('отвергает запрос без пользователя', () => {
    expect(() => controller.list(request(), WORKSPACE_ID)).toThrow(
      UnauthorizedException,
    );
  });
});
