/**
 * Читает положительное число из переменной окружения.
 *
 * Пустое, нечисловое, нулевое или отрицательное значение не должно ломать
 * фоновые jobs: вместо ошибки берётся значение по умолчанию.
 */
export function readPositiveEnvNumber(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
