import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  BillingService,
  type LedgerHistoryEntry,
  type LedgerOperationResult,
  type WalletBalance,
} from './billing.service.js';
import { ChargeDto } from './dto/charge.dto.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { TopUpDto } from './dto/topup.dto.js';
import {
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

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly yooKassaProvider: YooKassaProvider,
  ) {}

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  getBalance(@Req() request: AuthenticatedRequest): Promise<WalletBalance> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.billingService.getBalance(userId);
  }

  @Get('ledger')
  @UseGuards(JwtAuthGuard)
  getLedger(
    @Req() request: AuthenticatedRequest,
  ): Promise<LedgerHistoryEntry[]> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.billingService.getTransactionHistory(userId);
  }

  /** Создаёт платёж в ЮKassa и возвращает ссылку на оплату. */
  @Post('create-payment')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
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
   * Всегда отвечаем 200, чтобы платёжный сервис не повторял уведомление
   * бесконечно; идемпотентность обеспечивает ключ `yookassa:<paymentId>`.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
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
  charge(@Body() dto: ChargeDto): Promise<LedgerOperationResult> {
    return this.billingService.chargeForSkill(
      dto.userId,
      dto.amount,
      dto.description ?? 'Списание за вызов Skill',
      dto.idempotencyKey,
    );
  }
}
