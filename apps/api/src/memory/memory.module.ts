import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmbeddingsService } from './embeddings.service.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { MemoryController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';
import { createVectorMemoryStore, VECTOR_MEMORY_STORE } from './vector-store.js';

/** Долговременная память агента (pgvector + API эмбеддингов). */
@Module({
  imports: [AuthModule],
  controllers: [MemoryController, KnowledgeController],
  providers: [
    EmbeddingsService,
    MemoryService,
    KnowledgeService,
    {
      provide: VECTOR_MEMORY_STORE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => createVectorMemoryStore(prisma),
    },
  ],
  exports: [MemoryService, EmbeddingsService],
})
export class MemoryModule {}
