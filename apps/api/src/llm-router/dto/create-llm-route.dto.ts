import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

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
