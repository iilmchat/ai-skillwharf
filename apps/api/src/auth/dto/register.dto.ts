import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { z } from 'zod';

/**
 * Zod-схема тела регистрации (KI-073).
 *
 * `inviteCode` необязателен на уровне схемы: нужен ли он, решает
 * `REGISTRATION_MODE` в `AuthService`. Схема отсекает пустые и слишком
 * длинные коды до constant-time сравнения.
 */
export const registerSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(128),
    inviteCode: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export class RegisterDto implements RegisterInput {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  inviteCode?: string;
}
