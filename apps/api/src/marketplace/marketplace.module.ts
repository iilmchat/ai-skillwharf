import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SkillSignatureService } from '../skills/skill-signature.service.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { DeveloperPortalController } from './developer-portal.controller.js';
import { DeveloperPortalService } from './developer-portal.service.js';
import { MarketplaceController } from './marketplace.controller.js';
import { MarketplaceService } from './marketplace.service.js';
import { SkillSecurityAuditService } from './skill-security-audit.service.js';

/** Публичный каталог навыков и портал автора (API-27.2, DEVPORTAL-36). */
@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [MarketplaceController, DeveloperPortalController],
  providers: [
    MarketplaceService,
    DeveloperPortalService,
    SkillSignatureService,
    SkillSecurityAuditService,
  ],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
