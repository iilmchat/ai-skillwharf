import { ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Runtime-политики Agent Gateway. Проверяют аргументы инструментов до
 * выполнения: модель не является границей безопасности.
 */
@Injectable()
export class AgentGatewayService {
  /**
   * Проверяет и при необходимости санитизирует аргументы вызова.
   * Возвращает аргументы, которые разрешено передать инструменту.
   */
  validateToolCall(toolName: string, args: any): any {
    if (toolName === 'execute_sandbox_code') {
      const code = typeof args?.code === 'string' ? args.code : '';
      const serialized = JSON.stringify(args ?? {});

      if (/rm\s+-rf\s+\//.test(code) || /rm\s+-rf\s+\//.test(serialized)) {
        throw new ForbiddenException(
          'Действие заблокировано политикой безопасности',
        );
      }
    }

    if (
      toolName === 'web_search' &&
      typeof args?.query === 'string' &&
      /password|secret/i.test(args.query)
    ) {
      return { ...args, query: '[REDACTED]' };
    }

    return args;
  }
}
