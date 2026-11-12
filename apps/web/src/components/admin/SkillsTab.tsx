import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAdminErrorMessage,
  importSkillArchive,
  type ImportedSkill,
} from '../../lib/admin';

export function SkillsTab() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [imported, setImported] = useState<ImportedSkill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isSubmitting) {
        setIsOpen(false);
        setFile(null);
        setError(null);
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  function openModal() {
    setFile(null);
    setError(null);
    setIsOpen(true);
  }

  function closeModal() {
    if (isSubmitting) {
      return;
    }

    setIsOpen(false);
    setFile(null);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (file === null) {
      setError(t('admin.skills.noFile'));
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await importSkillArchive(file);
      setImported(result);
      setIsOpen(false);
      setFile(null);
    } catch (submitError) {
      setError(getAdminErrorMessage(submitError, 'admin.skills.importError'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-on-surface">
            {t('admin.skills.title')}
          </h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {t('admin.skills.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={openModal}
          className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t('admin.skills.import')}
        </button>
      </div>

      {imported !== null && (
        <div
          role="status"
          className="mt-6 rounded-2xl border border-success/30 bg-success/10 p-5 text-on-surface"
        >
          <p className="font-semibold text-success">
            {t('admin.skills.success')}
          </p>
          <p className="mt-1 text-sm text-on-surface-variant">
            {imported.name} · v{imported.version}
          </p>
          {imported.warning !== undefined && (
            <p className="mt-2 text-sm text-on-surface-variant">
              {imported.warning}
            </p>
          )}
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-dashed border-outline px-6 py-10 text-center">
        <h3 className="font-display text-lg font-bold text-on-surface">
          {t('admin.skills.emptyTitle')}
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-on-surface-variant">
          {t('admin.skills.emptyBody')}
        </p>
      </div>

      {isOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-import-title"
            className="w-full max-w-lg rounded-3xl border border-outline-variant bg-surface p-6 shadow-2xl"
          >
            <h2
              id="skill-import-title"
              className="font-display text-xl font-bold text-on-surface"
            >
              {t('admin.skills.modalTitle')}
            </h2>
            <p className="mt-2 text-sm text-on-surface-variant">
              {t('admin.skills.modalSubtitle')}
            </p>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="skill-import-file"
                  className="block text-sm font-medium text-on-surface"
                >
                  {t('admin.skills.fileLabel')}
                </label>
                <input
                  ref={inputRef}
                  id="skill-import-file"
                  type="file"
                  accept=".zip"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setError(null);
                  }}
                  className="mt-2 block w-full rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-sm text-on-surface file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-on-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <p className="mt-2 text-xs text-on-surface-variant">
                  {t('admin.skills.fileHint')}
                </p>
              </div>

              {error !== null && (
                <p
                  role="alert"
                  className="rounded-xl border border-error/30 bg-error-container p-3 text-sm text-on-error-container"
                >
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={isSubmitting}
                  className="rounded-xl border border-outline px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
                >
                  {t('admin.skills.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
                >
                  {isSubmitting
                    ? t('admin.skills.submitting')
                    : t('admin.skills.submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
