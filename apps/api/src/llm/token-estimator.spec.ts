import { HumanMessage } from '@langchain/core/messages';
import {
  MESSAGE_OVERHEAD_TOKENS,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateUsageFromMessages,
} from './token-estimator.js';

describe('token-estimator', () => {
  it('считает токены кодировщиком cl100k_base', () => {
    // Значение проверено офлайн на js-tiktoken@1.0.21: cl100k_base даёт
    // 9 токенов для этой строки (эвристика chars/4 дала бы 6).
    expect(estimateTextTokens('Привет, мир! Hello world')).toBe(9);
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('   ')).toBe(0);
  });

  it('добавляет служебные токены на каждое сообщение', () => {
    expect(estimateMessagesTokens([new HumanMessage('')])).toBe(
      MESSAGE_OVERHEAD_TOKENS,
    );
    expect(
      estimateMessagesTokens([new HumanMessage(''), new HumanMessage('')]),
    ).toBe(MESSAGE_OVERHEAD_TOKENS * 2);
  });

  it('учитывает системный промпт', () => {
    const messages = [new HumanMessage('привет')];
    const prompt = 'Системная инструкция';

    expect(estimateMessagesTokens(messages, prompt)).toBe(
      estimateMessagesTokens(messages) +
        estimateTextTokens(prompt) +
        MESSAGE_OVERHEAD_TOKENS,
    );
    // Пустой промпт ничего не добавляет.
    expect(estimateMessagesTokens(messages, '  ')).toBe(
      estimateMessagesTokens(messages),
    );
  });

  it('оценивает полный usage вызова', () => {
    const messages = [new HumanMessage('привет')];
    const input = estimateMessagesTokens(messages, 'система');
    const output = estimateTextTokens('ответ');

    expect(estimateUsageFromMessages(messages, 'ответ', 'система')).toEqual({
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
    });
  });
});
