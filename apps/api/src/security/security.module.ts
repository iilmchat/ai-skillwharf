import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AgentGatewayService } from './agent-gateway.service.js';

@Module({
  imports: [AuditModule],
  providers: [AgentGatewayService],
  exports: [AgentGatewayService],
})
export class SecurityModule {}
