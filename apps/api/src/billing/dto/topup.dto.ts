import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

export class TopUpDto {
  /**
   * Чей кошелёк пополнить. Обычному пользователю передавать не нужно — сервер
   * возьмёт `userId` из JWT; значение учитывается только для роли `admin`.
   */
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @IsString()
  @MaxLength(128)
  idempotencyKey: string;
}
