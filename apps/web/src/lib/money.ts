export const CURRENCY_SYMBOL = '₽';

export function getCurrencySymbol(currency: 'RUB' | 'USD' | undefined): string {
  return currency === 'USD' ? '$' : CURRENCY_SYMBOL;
}

/** Форматирует денежную строку API без изменения её точности. */
export function formatMoney(value: string, language: string): string {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return value;
  }

  return new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
