import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { DocumentToolsService } from '../agent/documents/document-tools.service.js';
import { OcrSmartEngineService } from '../agent/documents/ocr-smart-engine.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/**
 * Документы: загрузка из UI (`POST /documents`) и инструменты агента.
 *
 * `OcrSmartEngineService` и `DocumentToolsService` живут здесь и
 * экспортируются в `AgentModule`, чтобы OCR был один на API (общий клиент
 * Smart Document Engine и общий fallback в песочнице).
 */
@Module({
  imports: [AuthModule, SandboxModule],
  controllers: [DocumentsController],
  providers: [OcrSmartEngineService, DocumentToolsService, DocumentsService],
  exports: [OcrSmartEngineService, DocumentToolsService],
})
export class DocumentsModule {}
