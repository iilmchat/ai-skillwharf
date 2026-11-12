import { MOCK_REGISTRY_SKILLS } from './mock-registry.js';
import { RegistryController } from './registry.controller.js';

describe('RegistryController', () => {
  it('отдаёт мок-реестр навыков', () => {
    const controller = new RegistryController();

    const skills = controller.list();

    expect(skills).toBe(MOCK_REGISTRY_SKILLS);
    expect(skills.map((skill) => skill.name)).toEqual([
      'weather-api',
      'pdf-parser',
      'sql-runner',
    ]);

    for (const skill of skills) {
      expect(skill).toEqual({
        name: expect.any(String),
        description: expect.any(String),
        author: expect.any(String),
        version: expect.any(String),
        price: expect.any(Number),
        permissions: expect.any(Array),
      });
    }
  });
});
