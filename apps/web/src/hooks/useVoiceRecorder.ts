import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeVoiceAudio } from '../lib/knowledge';

export type VoiceRecorderStatus =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'error';

export type VoiceRecorderErrorKey =
  | 'chat.voice.errors.unsupported'
  | 'chat.voice.errors.denied'
  | 'chat.voice.errors.failed'
  | 'chat.voice.errors.transcribe';

export interface VoiceRecorderState {
  status: VoiceRecorderStatus;
  /** Целые секунды записи — для индикатора в строке ввода. */
  seconds: number;
  isSupported: boolean;
  errorKey: VoiceRecorderErrorKey | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Прервать запись без транскрибации. */
  cancel: () => void;
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    return 'audio/webm';
  }

  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

  for (const candidate of candidates) {
    if (
      typeof MediaRecorder.isTypeSupported === 'function' &&
      MediaRecorder.isTypeSupported(candidate)
    ) {
      return candidate;
    }
  }

  return '';
}

function release(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Запись голоса через `getUserMedia`/`MediaRecorder` и отправка аудио на
 * `POST /chat/transcribe`. Распознанный текст возвращается в чат через колбэк.
 */
export function useVoiceRecorder({
  onTranscript,
}: {
  onTranscript: (text: string) => void;
}): VoiceRecorderState {
  const [status, setStatus] = useState<VoiceRecorderStatus>('idle');
  const [seconds, setSeconds] = useState(0);
  const [errorKey, setErrorKey] = useState<VoiceRecorderErrorKey | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const isSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia !== undefined;

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearTimer();
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      release(streamRef.current);
    },
    [clearTimer],
  );

  const start = useCallback(async (): Promise<void> => {
    if (!isSupported) {
      setErrorKey('chat.voice.errors.unsupported');
      setStatus('error');
      return;
    }

    setErrorKey(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType === '' ? undefined : { mimeType },
      );

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.start(250);

      setSeconds(0);
      setStatus('recording');
      clearTimer();
      timerRef.current = window.setInterval(() => {
        setSeconds((value) => value + 1);
      }, 1000);
    } catch (error: unknown) {
      const denied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'SecurityError');

      release(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      setErrorKey(
        denied ? 'chat.voice.errors.denied' : 'chat.voice.errors.failed',
      );
      setStatus('error');
    }
  }, [clearTimer, isSupported]);

  const stop = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;

    if (recorder === null || recorder.state === 'inactive') {
      return;
    }

    clearTimer();
    setStatus('transcribing');

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const blob = new Blob(chunksRef.current, {
      type: recorder.mimeType === '' ? 'audio/webm' : recorder.mimeType,
    });

    release(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setSeconds(0);

    try {
      const result = await transcribeVoiceAudio(blob);

      onTranscriptRef.current(result.text);
      setErrorKey(null);
      setStatus('idle');
    } catch {
      setErrorKey('chat.voice.errors.transcribe');
      setStatus('error');
    }
  }, [clearTimer]);

  const cancel = useCallback((): void => {
    clearTimer();
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    release(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setSeconds(0);
    setErrorKey(null);
    setStatus('idle');
  }, [clearTimer]);

  return { status, seconds, isSupported, errorKey, start, stop, cancel };
}
