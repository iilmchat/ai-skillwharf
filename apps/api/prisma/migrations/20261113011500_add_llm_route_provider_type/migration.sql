-- Провайдер LLM для маршрута Control Plane: OpenAI, YandexGPT или GigaChat.
ALTER TABLE "LlmRoute" ADD COLUMN "providerType" TEXT NOT NULL DEFAULT 'OpenAI';
