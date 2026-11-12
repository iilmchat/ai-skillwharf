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
import {
  LLM_PROVIDER_TYPES,
  type LlmProviderType,
} from './create-llm-route.dto.js';

export class UpdateLlmRouteDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  baseUrl?: string;

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
