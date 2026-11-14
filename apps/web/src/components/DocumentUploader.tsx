import { useId, useState, type ChangeEvent, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useDocumentUpload } from '../hooks/useDocumentUpload';
import { DOCUMENT_ACCEPT, MAX_DOCUMENT_BYTES } from '../lib/documents';
import { DocumentResult } from './DocumentResult';

const DROPZONE_BASE =
  'flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition';

/**
 * Загрузка PDF или изображения: drag-and-drop и выбор файла, прогресс и
 * разобранный результат.
 */
export function DocumentUploader({
  onSendToChat,
  onClose,
}: {
  onSendToChat: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const { status, progress, fileName, document, errorKey, upload, reset } =
    useDocumentUpload();

  const isUploading = status === 'uploading';
  const showDropzone = status === 'idle' || status === 'error';

  function handleFiles(files: FileList | null): void {
    const file = files?.[0];

    if (file === undefined) {
      return;
    }

    void upload(file);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    handleFiles(event.target.files);
    // Сброс значения позволяет выбрать тот же файл повторно.
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  return (
    <section
      id="chat-document-upload"
      aria-labelledby="document-upload-title"
      className="rounded-2xl border border-outline-variant bg-surface-container/60 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="document-upload-title"
            className="text-sm font-semibold text-on-surface"
          >
            {t('chat.upload.title')}
          </h2>
          <p className="mt-0.5 text-xs text-on-surface-variant">
            {t('chat.upload.subtitle', {
              size: Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024)),
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('chat.upload.close')}
          title={t('chat.upload.close')}
          className="rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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

      {showDropzone && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`mt-3 ${DROPZONE_BASE} ${
            isDragging
              ? 'border-primary bg-primary-container/40'
              : 'border-outline bg-surface'
          }`}
        >
          <input
            id={inputId}
            type="file"
            accept={DOCUMENT_ACCEPT}
            onChange={handleInputChange}
            disabled={isUploading}
            className="sr-only"
          />
          <label
            htmlFor={inputId}
            className="flex cursor-pointer flex-col items-center gap-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-xl border border-outline-variant bg-surface-container text-on-surface-variant"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-5"
              >
                <path d="M12 16V4M7 9l5-5 5 5" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
            </span>
            <span className="text-xs font-medium text-on-surface">
              {t('chat.upload.dropzone')}
            </span>
            <span className="rounded-lg border border-outline px-3 py-1.5 text-xs font-semibold text-on-surface-variant">
              {t('chat.upload.choose')}
            </span>
          </label>
          <p className="text-[11px] text-on-surface-variant">
            {t('chat.upload.hint')}
          </p>
        </div>
      )}

      {errorKey !== null && status === 'error' && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-xs leading-relaxed text-on-error-container"
        >
          {t(errorKey)}
        </div>
      )}

      {isUploading && (
        <div className="mt-3 space-y-2">
          <p role="status" className="text-xs text-on-surface-variant">
            {progress === null
              ? t('chat.upload.uploading', { name: fileName ?? '' })
              : t('chat.upload.uploadingPercent', {
                  name: fileName ?? '',
                  percent: progress,
                })}
          </p>
          <div
            role="progressbar"
            aria-label={t('chat.upload.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high"
          >
            <div
              className={`h-full rounded-full bg-primary transition-all ${
                progress === null ? 'w-full animate-pulse' : ''
              }`}
              style={progress === null ? undefined : { width: `${progress}%` }}
            />
          </div>
          <button
            type="button"
            onClick={reset}
            className="text-xs font-semibold text-on-surface-variant underline-offset-2 transition hover:text-on-surface hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('chat.upload.cancel')}
          </button>
        </div>
      )}

      {status === 'done' && document !== null && (
        <div className="mt-3">
          <DocumentResult
            document={document}
            onSendToChat={onSendToChat}
            onUploadAnother={reset}
          />
        </div>
      )}
    </section>
  );
}
