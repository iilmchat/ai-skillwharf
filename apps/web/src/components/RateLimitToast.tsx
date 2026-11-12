import { useTranslation } from 'react-i18next';
import { useRateLimitStore } from '../lib/rate-limit';
import { ErrorToast } from './ErrorToast';

/** Красный тост «слишком много попыток» поверх любого экрана. */
export function RateLimitToast() {
  const { t } = useTranslation();
  const signal = useRateLimitStore((state) => state.signal);
  const clear = useRateLimitStore((state) => state.clear);

  if (signal === 0) {
    return null;
  }

  return (
    <ErrorToast
      key={signal}
      message={t('errors.rateLimit')}
      onClose={clear}
    />
  );
}
