import { ForbiddenException } from '@nestjs/common';
import { AgentGatewayService } from './agent-gateway.service.js';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;

  beforeEach(() => {
    service = new AgentGatewayService();
  });

  it('блокирует rm -rf / в execute_sandbox_code', () => {
    expect(() =>
      service.validateToolCall('execute_sandbox_code', {
        code: 'rm -rf / --no-preserve-root',
      }),
    ).toThrow(ForbiddenException);
  });

  it('пропускает безопасный код без изменений', () => {
    const args = { code: 'echo ok' };

    expect(service.validateToolCall('execute_sandbox_code', args)).toBe(args);
  });

  it('маскирует секреты в поисковом запросе', () => {
    const args = service.validateToolCall('web_search', {
      query: 'найди password от админки',
    });

    expect(args).toEqual({ query: '[REDACTED]' });
  });

  it('не трогает обычный поисковый запрос', () => {
    const args = { query: 'погода в Москве' };

    expect(service.validateToolCall('web_search', args)).toBe(args);
  });
});
