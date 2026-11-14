import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DOCUMENT_ERROR_KEYS,
  classifyDocumentError,
  uploadDocument,
  validateDocumentFile,
  type DocumentErrorKey,
  type ParsedDocument,
} from '../lib/documents';

export type DocumentUploadStatus = 'idle' | 'uploading' | 'done' | 'error';

export interface DocumentUploadState {
  status: DocumentUploadStatus;
  /** Процент загрузки; `null` — браузер не сообщил размер файла. */
  progress: number | null;
  fileName: string | null;
  document: ParsedDocument | null;
  errorKey: DocumentErrorKey | null;
  upload: (file: File) => Promise<void>;
  /** Отменяет отправку и сбрасывает состояние. */
  cancel: () => void;
  reset: () => void;
}

/**
 * Загрузка документа в `POST /documents` с прогрессом.
 *
 * Состояния: `idle` → `uploading` (прогресс) → `done` | `error`. Повторный
 * вызов `upload` отменяет предыдущую отправку, `cancel` доступен во время
 * загрузки, `reset` возвращает форму к выбору файла.
 */
export function useDocumentUpload(): DocumentUploadState {
  const [status, setStatus] = useState<DocumentUploadStatus>('idle');
  const [progress, setProgress] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [document, setDocument] = useState<ParsedDocument | null>(null);
  const [errorKey, setErrorKey] = useState<DocumentErrorKey | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus('idle');
    setProgress(null);
    setFileName(null);
    setDocument(null);
    setErrorKey(null);
  }, []);

  const upload = useCallback(async (file: File): Promise<void> => {
    const validation = validateDocumentFile({
      name: file.name,
      size: file.size,
      type: file.type,
    });

    controllerRef.current?.abort();

    if (!validation.ok) {
      setStatus('error');
      setProgress(null);
      setFileName(file.name);
      setDocument(null);
      setErrorKey(validation.errorKey);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('uploading');
    setProgress(0);
    setFileName(file.name);
    setDocument(null);
    setErrorKey(null);

    try {
      const parsed = await uploadDocument(file, {
        signal: controller.signal,
        onProgress: (percent) => {
          if (!controller.signal.aborted) {
            setProgress(percent);
          }
        },
      });

      if (controller.signal.aborted) {
        return;
      }

      setDocument(parsed);
      setProgress(100);
      setStatus('done');
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }

      setProgress(null);
      setErrorKey(DOCUMENT_ERROR_KEYS[classifyDocumentError(error)]);
      setStatus('error');
    }
  }, []);

  return {
    status,
    progress,
    fileName,
    document,
    errorKey,
    upload,
    cancel: reset,
    reset,
  };
}
