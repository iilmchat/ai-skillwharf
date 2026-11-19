import { useEffect, useRef, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketplaceSkill } from '../lib/marketplace';

interface MarketplaceSkillModalProps {
  /** Открытый навык или `null`, если окно закрыто. */
  skill: MarketplaceSkill | null;
  onClose: () => void;
}

export function MarketplacePrice({ skill }: { skill: MarketplaceSkill }) {
  const { t } = useTranslation();

  switch (skill.pricingModel) {
    case 'Free':
      return <>{t('marketplace.pricing.free')}</>;
    case 'Pay-per-Call':
      return <>{t('marketplace.pricing.payPerCall', { price: skill.price })}</>;
    case 'Pay-per-Outcome':
      return (
        <>{t('marketplace.pricing.payPerOutcome', { price: skill.price })}</>
      );
    case 'Freemium':
      return <>{t('marketplace.pricing.freemium', { price: skill.price })}</>;
    case 'Subscription':
      return (
        <>{t('marketplace.pricing.subscription', { price: skill.price })}</>
      );
  }
}

/** Детали навыка: описание, разрешения и статус подписи Ed25519. */
export function MarketplaceSkillModal({
  skill,
  onClose,
}: MarketplaceSkillModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = skill !== null;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }

      const timeoutId = window.setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget) {
      dialogRef.current?.close();
    }
  }

  const signatureVerified = skill?.signature?.verified ?? skill?.verified ?? false;
  const signatureStatus = skill?.signature?.status;
  const signatureNote =
    signatureStatus === 'verified'
      ? t('marketplace.details.signatureVerified')
      : signatureStatus === 'invalid' || signatureStatus === 'unverified'
        ? t('marketplace.details.signatureUnverified')
        : t('marketplace.details.signatureAlgorithm');

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="marketplace-dialog-title"
      onClick={handleBackdropClick}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      {skill !== null && (
        <div className="flex max-h-[85svh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-outline-variant px-6 py-5 sm:px-7">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                {t('marketplace.details.eyebrow')}
              </p>
              <h2
                id="marketplace-dialog-title"
                className="mt-1 font-display text-2xl font-bold tracking-tight text-on-surface"
              >
                {skill.name}
              </h2>
              <p className="mt-1 text-sm text-on-surface-variant">
                {t('skills.versionAuthor', {
                  version: skill.version,
                  author: skill.authorName,
                })}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label={t('common.close')}
              className="shrink-0 rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="size-4"
              >
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 space-y-6 overflow-y-auto overscroll-contain px-6 py-5 sm:px-7">
            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
                {t('marketplace.details.descriptionLabel')}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-on-surface">
                {skill.description}
              </p>
            </section>

            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
                {t('marketplace.details.permissionsLabel')}
              </h3>
              {skill.permissions === undefined || skill.permissions.length === 0 ? (
                <p className="mt-2 text-sm text-on-surface-variant">
                  {t('marketplace.details.permissionsEmpty')}
                </p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {skill.permissions.map((permission) => (
                    <li
                      key={permission}
                      className="rounded-lg border border-outline-variant bg-surface-container px-2.5 py-1 text-xs text-on-surface-variant"
                    >
                      {permission}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
                {t('marketplace.details.signatureLabel')}
              </h3>
              <div className="mt-2 flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`mt-0.5 size-5 shrink-0 ${
                    signatureVerified
                      ? 'text-primary'
                      : 'text-on-surface-variant'
                  }`}
                >
                  <path d="M12 3 4.5 6v5.5c0 4.8 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.7 7.5-9.5V6L12 3Z" />
                  {signatureVerified ? <path d="m9 12 2 2 4-4" /> : null}
                </svg>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-on-surface">
                    {signatureVerified
                      ? t('marketplace.details.signatureVerified')
                      : t('marketplace.details.signatureUnverified')}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-on-surface-variant">
                    {signatureNote}
                  </p>
                  {skill.signature?.publicKeyId !== undefined && (
                    <p className="mt-0.5 text-xs text-on-surface-variant">
                      {t('marketplace.details.publicKeyId', {
                        id: skill.signature.publicKeyId,
                      })}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant pt-4 text-sm">
              <span className="font-semibold text-on-surface">
                <MarketplacePrice skill={skill} />
              </span>
              <span className="text-on-surface-variant">
                {t('marketplace.downloads', { count: skill.downloadsCount })}
              </span>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
