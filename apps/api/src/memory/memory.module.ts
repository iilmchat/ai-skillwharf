import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EmbeddingsService } from './embeddings.service.js';
import { MemoryController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';

/** Долговременная память агента (pgvector + API эмбеддингов). */
@Module({
  imports: [AuthModule],
  controllers: [MemoryController],
  providers: [EmbeddingsService, MemoryService],
  exports: [MemoryService, EmbeddingsService],
})
export class MemoryModule {}
