import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SkillsService, type SkillInstallResult } from './skills.service.js';

interface UploadedArchive {
  buffer?: Buffer;
  originalname?: string;
}

/** Максимальный размер ZIP-архива с навыком. */
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;

/**
 * Импорт навыков из OpenClaw. Архив обрабатывается в памяти: multer не
 * пишет файл на диск, а сервис читает из него `SKILL.md`.
 */
@Controller('admin/skills')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminSkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ARCHIVE_BYTES } }),
  )
  import(@UploadedFile() file?: UploadedArchive): Promise<SkillInstallResult> {
    if (file?.buffer === undefined || file.buffer.length === 0) {
      throw new BadRequestException('Прикрепите ZIP-архив с навыком');
    }

    return this.skillsService.importFromZip(file.buffer);
  }
}
