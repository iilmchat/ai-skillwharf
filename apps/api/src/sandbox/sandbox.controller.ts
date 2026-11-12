import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ExecuteSandboxDto } from './dto/execute-sandbox.dto.js';
import { SandboxService } from './sandbox.service.js';

@Controller('sandbox')
export class SandboxController {
  constructor(private readonly sandboxService: SandboxService) {}

  @Post('execute')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async execute(
    @Body() dto: ExecuteSandboxDto,
  ): Promise<{ stdout: string }> {
    const stdout = await this.sandboxService.runCommand(dto.code);

    return { stdout };
  }
}
