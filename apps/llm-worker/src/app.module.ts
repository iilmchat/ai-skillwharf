import { Module } from '@nestjs/common';
import { AgentBridgeService } from './agent/bridge.service.js';
import { AgentRunnerService } from './agent/runner.service.js';
import {
  GraphsController,
  WorkerHealthController,
} from './graph.controller.js';
import { LlmInferenceService } from './llm/inference.service.js';

@Module({
  controllers: [GraphsController, WorkerHealthController],
  providers: [AgentBridgeService, LlmInferenceService, AgentRunnerService],
})
export class AppModule {}
