import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const LLM_PROVIDER_TYPES = [
  'OpenAI',
  'YandexGPT',
  'GigaChat',
  'Ollama',
] as const;

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

/**
 * Типы задач маршрутизации. Fallback-цепочка строится только внутри одного
 * типа: чат не должен незаметно уходить на embeddings-модель.
 */
export const LLM_TASK_TYPES = ['chat', 'analysis', 'embeddings'] as const;

export type LlmTaskType = (typeof LLM_TASK_TYPES)[number];

export class CreateLlmRouteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  /**
   * Имя модели. Control Plane UI присылает `model`, внутренние клиенты —
   * `modelName`; сервис принимает оба варианта.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  modelName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  model?: string;

  @IsOptional()
  @IsIn(LLM_PROVIDER_TYPES)
  providerType?: LlmProviderType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  baseUrl: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  apiKeyEnvVar?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Тип задачи маршрута; по умолчанию `chat`. */
  @IsOptional()
  @IsIn(LLM_TASK_TYPES)
  taskType?: LlmTaskType;

  /** Дневной лимит затрат на маршрут в рублях; не задан — без лимита. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  dailyCostLimit?: number;
}
