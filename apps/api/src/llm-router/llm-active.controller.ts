import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { LlmRouterService } from './llm-router.service.js';

/** Активный маршрут без служебных полей: нужен шапке чата. */
export interface ActiveLlmRoute {
  name: string;
  modelName: string;
  providerType: string;
}

/**
 * Публичная для авторизованных пользователей информация о том, какая модель
 * обслуживает запросы. Base URL и имя env-переменной с ключом не отдаём.
 */
@Controller('llm')
@UseGuards(JwtAuthGuard)
export class LlmActiveController {
  constructor(private readonly llmRouterService: LlmRouterService) {}

  @Get('active')
  async active(): Promise<ActiveLlmRoute | null> {
    const route = await this.llmRouterService.selectRoute();

    if (route === null) {
      return null;
    }

    return {
      name: route.name,
      modelName: route.modelName,
      providerType: route.providerType,
    };
  }
}
