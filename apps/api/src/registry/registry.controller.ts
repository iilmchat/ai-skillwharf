import { Controller, Get } from '@nestjs/common';
import { MOCK_REGISTRY_SKILLS, type RegistrySkill } from './mock-registry.js';

@Controller('registry')
export class RegistryController {
  @Get('skills')
  list(): readonly RegistrySkill[] {
    return MOCK_REGISTRY_SKILLS;
  }
}
