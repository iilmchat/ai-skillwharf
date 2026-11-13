import { HumanMessage } from '@langchain/core/messages';
import {
  MESSAGE_OVERHEAD_TOKENS,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateUsageFromMessages,
} from './token-estimator.js';

// Кодировщик недоступен (нет словаря/повреждён пакет): оценка обязана
// деградировать до эвристики и не ронять вызов LLM.
vi.mock('js-tiktoken', () => ({
  getEncoding: () => {
    throw new Error('cl100k_base unavailable');
  },
}));

describe('token-estimator: эвристика без кодировщика', () => {
  it('считает chars/4, если кодировщик недоступен', () => {
    const text = 'Привет, мир! Hello world';

    expect(text.length).toBe(24);
    expect(estimateTextTokens(text)).toBe(6);
  });

  it('не добавляет токены за пустой текст', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('   ')).toBe(0);
  });

  it('сохраняет служебные токены сообщений', () => {
    expect(estimateMessagesTokens([new HumanMessage('')])).toBe(
      MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it('оценивает usage через fallback', () => {
    // 'abcd' = 1 токен, 'abcdefgh' = 2 токена, плюс 4 служебных.
    expect(
      estimateUsageFromMessages([new HumanMessage('abcd')], 'abcdefgh'),
    ).toEqual({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });
});
