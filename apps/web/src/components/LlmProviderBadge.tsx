import type { LlmProviderKind } from '../lib/llm';

/** Буквенный знак провайдера: заменяет иконку без внешних ассетов. */
const PROVIDER_MARK: Record<LlmProviderKind, string> = {
  OpenAI: 'AI',
  YandexGPT: 'Я',
  GigaChat: 'G',
  Ollama: 'OL',
};

const PROVIDER_STYLES: Record<LlmProviderKind, string> = {
  // YandexGPT — синий, GigaChat — зелёный, Ollama — фиолетовый.
  YandexGPT: 'bg-tertiary-container text-on-tertiary-container',
  GigaChat: 'bg-success/10 text-success',
  Ollama: 'bg-primary-container text-on-primary-container',
  OpenAI: 'bg-surface-container-high text-on-surface-variant',
};

const MARK_STYLES: Record<LlmProviderKind, string> = {
  YandexGPT: 'bg-tertiary/15 text-on-tertiary-container',
  GigaChat: 'bg-success/15 text-success',
  Ollama: 'bg-primary/15 text-on-primary-container',
  OpenAI: 'bg-outline/20 text-on-surface-variant',
};

interface LlmProviderBadgeProps {
  provider: LlmProviderKind;
  /** Модель показывается рядом с провайдером, если передана. */
  modelName?: string;
  /** Компактный вид для шапки чата. */
  size?: 'sm' | 'md';
  title?: string;
}

/** Цветной бейдж провайдера LLM с буквенным знаком. */
export function LlmProviderBadge({
  provider,
  modelName,
  size = 'md',
  title,
}: LlmProviderBadgeProps) {
  const isSmall = size === 'sm';

  return (
    <span
      title={title}
      aria-label={
        modelName === undefined ? provider : `${provider}: ${modelName}`
      }
      className={`inline-flex items-center gap-1.5 rounded-full font-semibold ${PROVIDER_STYLES[provider]} ${
        isSmall ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid place-items-center rounded-full font-bold ${MARK_STYLES[provider]} ${
          isSmall ? 'size-3.5 text-[8px]' : 'size-4 text-[9px]'
        }`}
      >
        {PROVIDER_MARK[provider]}
      </span>
      <span className="truncate">{provider}</span>
    </span>
  );
}
