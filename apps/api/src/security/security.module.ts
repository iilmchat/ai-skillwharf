import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AgentGatewayService } from './agent-gateway.service.js';
import { PiiMaskingService } from './pii-masking.service.js';

@Module({
  imports: [AuditModule],
  providers: [AgentGatewayService, PiiMaskingService],
  exports: [AgentGatewayService, PiiMaskingService],
})
export class SecurityModule {}
