import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdminSkillsController } from './admin-skills.controller.js';
import { SkillsController } from './skills.controller.js';
import { SkillSignatureService } from './skill-signature.service.js';
import { SkillsService } from './skills.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SkillsController, AdminSkillsController],
  providers: [SkillSignatureService, SkillsService],
  exports: [SkillsService, SkillSignatureService],
})
export class SkillsModule {}
