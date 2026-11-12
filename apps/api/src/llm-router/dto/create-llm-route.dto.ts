import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const LLM_PROVIDER_TYPES = [
  'OpenAI',
  'YandexGPT',
  'GigaChat',
] as const;

export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];

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
}
