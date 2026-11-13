import {
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import {
  financeOverviewResponseSchema,
  fraudShieldQuerySchema,
  profitLeaksQuerySchema,
  unitEconomicsQuerySchema,
  type FinanceOverviewResponse,
} from './finance-contracts.js';
import {
  FinanceService,
  type FraudShieldResponse,
  type ProfitLeaksListResponse,
  type UnitEconomicsListResponse,
} from './finance.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/**
 * Финансовый дашборд (Sprint 19, Track J).
 *
 * `GET /finance/overview` — агрегат последних результатов `unit-economics`,
 * `profit-leak-detector` и `fraud-shield-audit` текущего пользователя.
 * Fallback-маршруты (`/finance/unit-economics`, `/finance/profit-leaks`,
 * `/finance/fraud-shield`) отдают те же данные по частям и поддерживают
 * фильтры.
 *
 * Данные — только сохранённые результаты реальных MCP-вызовов Ozon/WB
 * (`FinanceSnapshotStore`): GET ничего не считает, не тратит квоты
 * маркетплейсов и не обходит оплату навыков. Если расчётов ещё не было,
 * ответ содержит `dataAvailable: false` и причину, а не вымышленные суммы.
 */
@Controller('finance')
@UseGuards(JwtAuthGuard)
export class FinanceController {
  private readonly logger = new Logger(FinanceController.name);

  constructor(private readonly finance: FinanceService) {}

  @Get('overview')
  async overview(
    @Req() request: AuthenticatedRequest,
  ): Promise<FinanceOverviewResponse> {
    const userId = requireUserId(request);
    const overview = await this.finance.overview(userId);
    const parsed = financeOverviewResponseSchema.safeParse(overview);

    if (!parsed.success) {
      // Ответ разошёлся с контрактом UI: это баг API, а не клиента.
      this.logger.error(
        `Ответ /finance/overview не соответствует контракту: ${parsed.error.message}`,
      );
      throw new InternalServerErrorException(
        'Ответ финансового дашборда не соответствует контракту',
      );
    }

    return parsed.data;
  }

  @Get('unit-economics')
  async unitEconomics(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<UnitEconomicsListResponse> {
    const userId = requireUserId(request);
    const parsed = unitEconomicsQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw invalidRequestError(describeIssues(parsed.error.issues));
    }

    return this.finance.unitEconomics(userId, parsed.data);
  }

  @Get('profit-leaks')
  async profitLeaks(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<ProfitLeaksListResponse> {
    const userId = requireUserId(request);
    const parsed = profitLeaksQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw invalidRequestError(describeIssues(parsed.error.issues));
    }

    return this.finance.profitLeaks(userId, parsed.data);
  }

  @Get('fraud-shield')
  async fraudShield(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<FraudShieldResponse> {
    const userId = requireUserId(request);
    const parsed = fraudShieldQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw invalidRequestError(describeIssues(parsed.error.issues));
    }

    return this.finance.fraudShield(userId, parsed.data);
  }
}

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}

function describeIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  const details = issues
    .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
    .join('; ');

  return `Некорректные параметры запроса: ${details}`;
}
