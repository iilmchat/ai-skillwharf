import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SkillSignatureService } from '../skills/skill-signature.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';

/** Публичный каталог навыков и установка в 1 клик (API-27.2). */
@Module({
  imports: [AuthModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, SkillSignatureService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
