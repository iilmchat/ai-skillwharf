import { Module } from '@nestjs/common';
import { RegistryController } from './registry.controller.js';

@Module({
  controllers: [RegistryController],
})
export class RegistryModule {}
