/**
 * Типы провайдеров LLM, для которых есть нативный адаптер (свой протокол).
 * Остальные считаются OpenAI-совместимыми.
 */
export const NATIVE_PROVIDER_TYPES = ['YandexGPT', 'GigaChat'] as const;

/** Нативный провайдер: YandexGPT или GigaChat. */
export type NativeProviderType = (typeof NATIVE_PROVIDER_TYPES)[number];

/** Провайдер по умолчанию. */
export const DEFAULT_PROVIDER_TYPE = 'OpenAI';

/**
 * Нормализует `providerType` из маршрута: неизвестные и пустые значения
 * трактуются как OpenAI-совместимый провайдер.
 */
export function normalizeProviderType(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_PROVIDER_TYPE;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return DEFAULT_PROVIDER_TYPE;
  }

  const match = NATIVE_PROVIDER_TYPES.find(
    (type) => type.toLowerCase() === trimmed.toLowerCase(),
  );

  return match ?? trimmed;
}

/** Нужен ли для этого провайдера нативный адаптер. */
export function isNativeProviderType(
  value: unknown,
): value is NativeProviderType {
  return NATIVE_PROVIDER_TYPES.includes(
    normalizeProviderType(value) as NativeProviderType,
  );
}
