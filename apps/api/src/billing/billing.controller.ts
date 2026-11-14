import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import {
  BillingService,
  type LedgerOperationResult,
  type WalletBalance,
} from './billing.service.js';
import { ChargeDto } from './dto/charge.dto.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { LedgerQuerySchema } from './dto/ledger-query.dto.js';
import {
  LedgerPageSchema,
  type LedgerPage,
} from './dto/ledger-response.dto.js';
import { TopUpDto } from './dto/topup.dto.js';
import {
  isPaymentNotificationConfirmed,
  YooKassaProvider,
  type YooKassaWebhookPayload,
} from './providers/yookassa.provider.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Ответ на создание платежа: ссылка на страницу оплаты. */
export interface PaymentLink {
  url: string;
}

/** Дефолтный URL возврата после оплаты. */
const DEFAULT_RETURN_URL = 'http://localhost:8080/app/chat?payment=success';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly yooKassaProvider: YooKassaProvider,
  ) {}

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Баланс кошелька текущего пользователя' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Баланс и текущий Freemium-лимит.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  getBalance(@Req() request: AuthenticatedRequest): Promise<WalletBalance> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.billingService.getBalance(userId);
  }

  /**
   * Страница истории операций текущего пользователя.
   * `GET /api/v1/billing/ledger?limit=20&offset=0` либо `?cursor=<opaque>`.
   *
   * `userId` берётся только из JWT. Query и ответ проходят Zod-валидацию,
   * поэтому контракт эндпоинта не «плывёт», а расхождение ответа с ним — баг
   * API (500), а не клиента.
   */
  @Get('ledger')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'История операций по кошельку' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Страница операций с курсором для следующей страницы.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Некорректные limit, offset или cursor.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  async getLedger(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<LedgerPage> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    const parsedQuery = LedgerQuerySchema.safeParse(query);

    if (!parsedQuery.success) {
      throw invalidRequestError(
        `Некорректные параметры запроса: ${parsedQuery.error.issues
          .map(
            (issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
    }

    const page = await this.billingService.getTransactionPage(
      userId,
      parsedQuery.data,
    );
    const parsedResponse = LedgerPageSchema.safeParse(page);

    if (!parsedResponse.success) {
      // Ответ сервиса разошёлся с контрактом: это баг API, а не клиента.
      // Клиенту отдаём 500 без вымышленных данных.
      this.logger.error(
        `Ответ истории операций не соответствует контракту: ${parsedResponse.error.message}`,
      );
      throw new InternalServerErrorException(
        'Ответ истории операций не соответствует контракту',
      );
    }

    return parsedResponse.data;
  }

  /** Создаёт платёж в ЮKassa и возвращает ссылку на оплату. */
  @Post('create-payment')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Создать платёж в ЮKassa' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Ссылка на страницу оплаты.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Некорректная сумма или returnUrl.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  async createPayment(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePaymentDto,
  ): Promise<PaymentLink> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    const returnUrl =
      dto.returnUrl ?? process.env.YOOKASSA_RETURN_URL ?? DEFAULT_RETURN_URL;
    const url = await this.yooKassaProvider.createPayment(
      userId,
      dto.amount,
      returnUrl,
    );

    return { url };
  }

  /**
   * Webhook ЮKassa. Публичный: ЮKassa не умеет ходить с нашим JWT.
   * Перед зачислением платёж перепроверяется запросом к API ЮKassa, поэтому
   * поддельное уведомление не пополнит баланс. Для остальных событий
   * отвечаем 200, чтобы платёжный сервис не повторял уведомление бесконечно;
   * идемпотентность обеспечивает ключ `yookassa:<paymentId>`.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Webhook ЮKassa',
    description:
      'Публичный маршрут: сумма и платёж перепроверяются запросом к API ЮKassa.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Уведомление принято или намеренно пропущено.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Уведомление не подтверждено ЮKassa.',
  })
  async webhook(
    @Body() payload: YooKassaWebhookPayload,
  ): Promise<{ ok: boolean }> {
    const notification = this.yooKassaProvider.parsePaymentSucceeded(payload);

    if (!notification) {
      this.logger.log(
        `ЮKassa webhook: событие «${payload?.event ?? 'unknown'}» пропущено`,
      );

      return { ok: true };
    }

    if (notification.paymentId === '') {
      throw new BadRequestException('В уведомлении отсутствует id платежа');
    }

    const payment = await this.yooKassaProvider.getPaymentStatus(
      notification.paymentId,
    );

    if (!isPaymentNotificationConfirmed(payment, notification)) {
      this.logger.warn(
        `ЮKassa webhook: платёж ${notification.paymentId} не подтверждён ЮKassa — уведомление отклонено`,
      );

      throw new BadRequestException('Платёж не подтверждён ЮKassa');
    }

    await this.billingService.addFunds(
      notification.userId,
      notification.amount,
      'Пополнение через ЮKassa',
      `yookassa:${notification.paymentId}`,
    );
    this.logger.log(
      `ЮKassa webhook: зачислено ${notification.amount.toFixed(2)} ₽ пользователю ${notification.userId}`,
    );

    return { ok: true };
  }

  /**
   * Прямое пополнение без оплаты. Доступно только админу и только для
   * тестовых/dev-сценариев: обычные пользователи пополняют баланс через
   * `POST /create-payment` (ЮKassa).
   */
  @Post('topup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Прямое пополнение кошелька',
    description: 'Доступно только администратору (dev/тестовые сценарии).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Операция пополнения применена.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Некорректная сумма или idempotencyKey.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Недостаточно прав: требуется роль admin.',
  })
  topup(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TopUpDto,
  ): Promise<LedgerOperationResult> {
    const currentUser = request.user;

    if (!currentUser) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    // Админ может пополнить любой кошелёк; без `userId` — свой.
    const userId = dto.userId ?? currentUser.userId;

    return this.billingService.addFunds(
      userId,
      dto.amount,
      dto.description ?? 'Пополнение баланса',
      dto.idempotencyKey,
    );
  }

  @Post('charge')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Списать стоимость вызова Skill',
    description: 'Доступно только администратору.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Списание применено.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Некорректная сумма или idempotencyKey.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Недостаточно прав: требуется роль admin.',
  })
  charge(@Body() dto: ChargeDto): Promise<LedgerOperationResult> {
    return this.billingService.chargeForSkill(
      dto.userId,
      dto.amount,
      dto.description ?? 'Списание за вызов Skill',
      dto.idempotencyKey,
    );
  }
}
