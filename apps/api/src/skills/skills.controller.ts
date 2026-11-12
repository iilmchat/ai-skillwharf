import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { InstalledSkill } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { InstallSkillDto } from './dto/install-skill.dto.js';
import { ValidateSkillDto } from './dto/validate-skill.dto.js';
import {
  SkillsService,
  type SkillValidationResult,
} from './skills.service.js';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Post('validate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  validate(@Body() dto: ValidateSkillDto): SkillValidationResult {
    const fileContent = dto.fileContent ?? dto.content;

    if (fileContent === undefined) {
      throw new BadRequestException(
        'Передайте текст SKILL.md в поле fileContent',
      );
    }

    return this.skillsService.validateManifest(fileContent);
  }

  @Post('install')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  install(@Body() dto: InstallSkillDto): Promise<InstalledSkill> {
    return this.skillsService.installSkill(dto.fileContent);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list(): Promise<InstalledSkill[]> {
    return this.skillsService.getInstalledSkills();
  }
}
