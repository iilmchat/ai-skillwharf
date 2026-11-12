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
  type TopUpResult,
  type WalletBalance,
} from './billing.service.js';
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

  @Post('topup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  topup(@Body() dto: TopUpDto): Promise<TopUpResult> {
    return this.billingService.addFunds(
      dto.userId,
      dto.amount,
      dto.description ?? 'Пополнение баланса',
    );
  }
}
