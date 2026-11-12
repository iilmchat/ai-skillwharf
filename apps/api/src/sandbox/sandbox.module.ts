import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SandboxController } from './sandbox.controller.js';
import { SandboxService } from './sandbox.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
