import { SkillsService } from './skills.service.js';

const validSkill = `---
name: web-researcher-pro
version: 1.2.0
description: Глубокий поиск информации в вебе с последующей проверкой источников.
author:
  name: SkillWharf Team
  email: team@skillwharf.ru
  url: https://skillwharf.ru
permissions:
  - network
  - filesystem
dependencies:
  tools:
    - web_search
    - read_file
pricing:
  model: Pay-per-Call
  price: 5
  currency: RUB
  freeCallsLimit: 10
---

# Web Researcher Pro

Инструкции для LLM: используй инструмент web_search.
`;

describe('SkillsService', () => {
  let service: SkillsService;

  beforeEach(() => {
    service = new SkillsService();
  });

  it('валидирует корректный SKILL.md', () => {
    expect(service.validateManifest(validSkill)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('возвращает ошибки, если обязательные поля отсутствуют', () => {
    const result = service.validateManifest(`---
name: web-researcher-pro
description: Без версии, автора и прав.
---

# Body
`);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/version|author|permissions/);
  });

  it('проверяет формат имени, версии и прав', () => {
    const result = service.validateManifest(`---
name: Web Researcher!
version: 1.0
description: Неверные значения.
author:
  name: Team
permissions:
  - teleport
---
`);

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/name|version|permissions/);
  });

  it('сообщает об отсутствии YAML frontmatter', () => {
    const result = service.validateManifest('# Просто Markdown без заголовка');

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('frontmatter');
  });

  it('обрабатывает синтаксически неверный YAML', () => {
    const result = service.validateManifest(`---
name: [незакрытый массив
---
`);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('YAML');
  });

  it('отклоняет YAML, который не является объектом манифеста', () => {
    const result = service.validateManifest(`---
- просто список
---
`);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
