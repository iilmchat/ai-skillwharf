import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { TopUpDto } from './dto/topup.dto.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

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

  @Post('topup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  topup(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TopUpDto,
  ): Promise<LedgerOperationResult> {
    const currentUser = request.user;

    if (!currentUser) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    // `userId` из тела учитывается только для админа. Обычный пользователь
    // пополняет свой кошелёк, даже если подставил чужой или не передал его.
    const userId =
      currentUser.role === 'admin' && dto.userId !== undefined
        ? dto.userId
        : currentUser.userId;

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
