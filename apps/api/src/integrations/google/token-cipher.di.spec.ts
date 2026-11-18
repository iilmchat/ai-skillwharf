import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { TokenCipherService } from './token-cipher.service.js';

@Injectable()
class Consumer {
  constructor(readonly cipher: TokenCipherService) {}
}

describe('TokenCipherService DI smoke', () => {
  it('resolves when registered as a provider', async () => {
    const module = await Test.createTestingModule({
      providers: [TokenCipherService, Consumer],
    }).compile();

    expect(module.get(Consumer).cipher).toBeInstanceOf(TokenCipherService);
  });
});
