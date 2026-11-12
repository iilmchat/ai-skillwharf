import { useTranslation } from 'react-i18next';
import { formatMoney, getCurrencySymbol } from '../lib/money';
import type { SkillPricing } from '../lib/skills';

/** Бейдж цены навыка: общий для «Навыков» и «Магазина». */
export function SkillPricingBadge({
  pricing,
}: {
  pricing: SkillPricing | undefined;
}) {
  const { t, i18n } = useTranslation();
  const isPayPerCall =
    pricing?.model === 'Pay-per-Call' && typeof pricing.price === 'number';
  const isPayPerOutcome =
    pricing?.model === 'Pay-per-Outcome' &&
    typeof pricing.price === 'number';
  const isPaid = isPayPerCall || isPayPerOutcome;
  let label: string = t('skills.pricing.free');

  if (isPayPerCall) {
    label = t('skills.pricing.payPerCall', {
      price: formatMoney(String(pricing.price), i18n.language),
      currency: getCurrencySymbol(pricing.currency),
    });
  } else if (isPayPerOutcome) {
    label = t('skills.pricing.payPerOutcome', {
      price: formatMoney(String(pricing.price), i18n.language),
      currency: getCurrencySymbol(pricing.currency),
    });
  } else if (pricing?.model === 'Subscription') {
    label = t('skills.pricing.subscription');
  } else if (pricing?.model === 'Freemium') {
    label = t('skills.pricing.freemium');
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        isPaid
          ? 'bg-tertiary-container text-on-tertiary-container'
          : 'bg-surface-container-high text-on-surface-variant'
      }`}
    >
      {label}
    </span>
  );
}
