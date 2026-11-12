/**
 * Billing Abstraction Layer (BAL): контракты между Gateway и платёжными
 * провайдерами.
 *
 * Здесь описаны только абстракции: конкретные адаптеры (ЮKassa, CloudPayments,
 * Тинькофф) и работа с Ledger реализуются вне этого пакета.
 */

/** Идентификатор пользователя — владельца кошелька. */
export type BillingUserId = string;

/** Идентификатор навыка, за вызов которого списываются средства. */
export type BillingSkillId = string;

/** Итоговый статус операции авторизации. */
export type TransactionStatus = "success" | "insufficient_funds" | "error";

/** DTO результата авторизации платежа. */
export interface TransactionResult {
  /** Итог попытки зарезервировать средства. */
  status: TransactionStatus;
  /** Идентификатор транзакции в BAL; присутствует при `status === "success"`. */
  transactionId?: string;
  /** Человекочитаемое описание ошибки для `insufficient_funds` и `error`. */
  errorMessage?: string;
}

/**
 * Абстракция платёжного провайдера для двухфазного списания (Hold -> Capture).
 *
 * Gateway не знает, какой провайдер используется: он вызывает `authorize` перед
 * запуском Sandbox, затем `capture` при успешном выполнении или `cancel` при
 * ошибке выполнения навыка.
 */
export interface IBillingProvider {
  /**
   * Резервирует средства пользователя (Hold).
   *
   * @param userId идентификатор пользователя
   * @param skillId идентификатор навыка
   * @param amount сумма в основных единицах валюты (например, 0.05 RUB)
   */
  authorize(
    userId: BillingUserId,
    skillId: BillingSkillId,
    amount: number,
  ): Promise<TransactionResult>;

  /**
   * Фиксирует резерв и проводит списание средств (Capture).
   *
   * @param transactionId идентификатор транзакции, полученный из `authorize`
   */
  capture(transactionId: string): Promise<void>;

  /**
   * Снимает резерв без списания средств (Rollback Hold).
   *
   * @param transactionId идентификатор транзакции, полученный из `authorize`
   */
  cancel(transactionId: string): Promise<void>;
}
