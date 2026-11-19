import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module.js';
import { SemanticCacheService } from './semantic-cache.service.js';

/** LLM-инфраструктура API: семантический кеш ответов (CACHE-30.2). */
@Module({
  imports: [MemoryModule],
  providers: [SemanticCacheService],
  exports: [SemanticCacheService],
})
export class LlmModule {}
