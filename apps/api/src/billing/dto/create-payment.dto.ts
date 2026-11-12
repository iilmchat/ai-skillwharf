import { IsNumber, IsPositive, IsUrl, IsOptional } from 'class-validator';

export class CreatePaymentDto {
  /** Сумма пополнения в рублях. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  /**
   * Куда вернуть пользователя после оплаты. Если не передан, используется
   * `YOOKASSA_RETURN_URL` из окружения.
   */
  @IsOptional()
  @IsUrl({ require_tld: false })
  returnUrl?: string;
}
