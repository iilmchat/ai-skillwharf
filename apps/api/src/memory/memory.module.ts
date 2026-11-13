import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service.js';
import { MemoryService } from './memory.service.js';

/** Долговременная память агента (pgvector + API эмбеддингов). */
@Module({
  providers: [EmbeddingsService, MemoryService],
  exports: [MemoryService, EmbeddingsService],
})
export class MemoryModule {}
