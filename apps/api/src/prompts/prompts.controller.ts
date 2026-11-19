import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PromptVersion } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreatePromptVersionDto } from './dto/create-prompt-version.dto.js';
import type { ExperimentView } from './prompt-experiment.schemas.js';
import type { EvalRunView } from './prompt-eval.schemas.js';
import { PromptEvalsService } from './prompt-evals.service.js';
import { PromptsService, type PromptTemplateView } from './prompts.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('prompts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'owner')
export class PromptsController {
  constructor(
    private readonly promptsService: PromptsService,
    private readonly evalsService: PromptEvalsService,
  ) {}

  @Get()
  list(): Promise<PromptTemplateView[]> {
    return this.promptsService.getTemplates();
  }

  @Get(':id/versions')
  versions(@Param('id') id: string): Promise<PromptVersion[]> {
    return this.promptsService.getVersions(id);
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  createVersion(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreatePromptVersionDto,
  ): Promise<PromptVersion> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.promptsService.createVersion(id, dto.content, userId);
  }

  /** Список A/B-экспериментов шаблона с усреднёнными метриками. */
  @Get(':id/experiments')
  experiments(@Param('id') id: string): Promise<ExperimentView[]> {
    return this.promptsService.listExperiments(id);
  }

  /** Запуск A/B-эксперимента (только один running на шаблон). */
  @Post(':id/experiments')
  @HttpCode(HttpStatus.CREATED)
  startExperiment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ExperimentView> {
    return this.promptsService.startExperiment(id, body, this.userId(request));
  }

  /** Остановка эксперимента с опциональным промоушеном победителя. */
  @Post('experiments/:expId/stop')
  @HttpCode(HttpStatus.OK)
  stopExperiment(
    @Req() request: AuthenticatedRequest,
    @Param('expId') expId: string,
    @Body() body: unknown,
  ): Promise<ExperimentView> {
    return this.promptsService.stopExperiment(
      expId,
      body ?? {},
      this.userId(request),
    );
  }

  /** История прогонов автоматической оценки промпта. */
  @Get(':id/evals')
  evalRuns(@Param('id') id: string): Promise<EvalRunView[]> {
    return this.evalsService.listRuns(id);
  }

  /** Запуск прогона Evals для версии промпта (опционально — по треку). */
  @Post(':id/evals/run')
  @HttpCode(HttpStatus.CREATED)
  runEval(@Param('id') id: string, @Body() body: unknown): Promise<EvalRunView> {
    return this.evalsService.runEvalForPrompt(id, body);
  }

  private userId(request: AuthenticatedRequest): string {
    const id = request.user?.userId;

    if (!id) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return id;
  }
}
