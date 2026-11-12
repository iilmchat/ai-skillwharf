import { Module } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service.js';

@Module({
  providers: [AgentGatewayService],
  exports: [AgentGatewayService],
})
export class SecurityModule {}
