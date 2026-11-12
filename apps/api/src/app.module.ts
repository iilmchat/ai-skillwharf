import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SkillsModule } from './skills/skills.module.js';

@Module({
  imports: [PrismaModule, HealthModule, AuthModule, ChatModule, SkillsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
