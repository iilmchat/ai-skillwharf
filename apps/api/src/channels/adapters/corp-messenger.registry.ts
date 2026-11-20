import { Injectable } from '@nestjs/common';
import { invalidRequestError } from '../../common/api-error.js';
import { PachcaAdapter } from './pachca.adapter.js';
import { VkTeamsAdapter } from './vk-teams.adapter.js';
import { YandexMessengerAdapter } from './yandex-messenger.adapter.js';
import {
  type CorpMessengerProvider,
  type ICorpMessengerAdapter,
} from './corp-messenger.types.js';

/** Реестр адаптеров корпоративных мессенджеров (OMNI-40.1). */
@Injectable()
export class CorpMessengerAdapterRegistry {
  private readonly adapters: ReadonlyMap<
    CorpMessengerProvider,
    ICorpMessengerAdapter
  > = new Map<CorpMessengerProvider, ICorpMessengerAdapter>([
    ['vk_teams', new VkTeamsAdapter()],
    ['pachca', new PachcaAdapter()],
    ['yandex_messenger', new YandexMessengerAdapter()],
  ]);

  get(provider: string): ICorpMessengerAdapter {
    const adapter = this.adapters.get(provider as CorpMessengerProvider);

    if (adapter === undefined) {
      throw invalidRequestError(`Неизвестный провайдер мессенджера: ${provider}`);
    }

    return adapter;
  }
}
