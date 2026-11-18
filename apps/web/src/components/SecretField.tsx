import type { ChangeEvent } from 'react';

/**
 * Поле секрета с маскировкой (KI-076).
 *
 * Значение по умолчанию скрыто (`type="password"`). Переключатель
 * «Показать»/«Скрыть» включается флагом `revealable`: он нужен там, где
 * пользователь осознанно сверяет введённый секрет, — например, в вебхуке
 * Битрикс24, где весь адрес является токеном доступа. Компонент
 * презентационный: видимость контролирует родитель, поэтому маскировка
 * возвращается при каждом новом монтировании карточки.
 */
export interface SecretFieldProps {
  id: string;
  name: string;
  label: string;
  hint: string;
  /** Дополнительное предупреждение под полем (например, о секретности URL). */
  note?: string;
  placeholder?: string;
  value: string;
  onValueChange: (value: string) => void;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  /** Показывать ли переключатель «Показать»/«Скрыть». */
  revealable: boolean;
  revealLabel: string;
  concealLabel: string;
  inputMode?: 'url';
  disabled?: boolean;
  error?: string | null;
  className: string;
}

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 9 7a11.7 11.7 0 0 1-2.2 3.2" />
      <path d="M6.6 6.6C4.4 8.1 3 10.4 3 12c0 2.5 4 7 9 7 1.6 0 3-.4 4.2-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function SecretField({
  id,
  name,
  label,
  hint,
  note,
  placeholder,
  value,
  onValueChange,
  visible,
  onVisibleChange,
  revealable,
  revealLabel,
  concealLabel,
  inputMode,
  disabled,
  error,
  className,
}: SecretFieldProps) {
  const isMasked = !revealable || !visible;
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;
  const isInvalid = error !== undefined && error !== null;

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onValueChange(event.target.value);
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={id}
          className="block text-sm font-medium text-on-surface"
        >
          {label}
        </label>
        {revealable && (
          <button
            type="button"
            onClick={() => onVisibleChange(!visible)}
            aria-label={visible ? concealLabel : revealLabel}
            aria-pressed={visible}
            aria-controls={id}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-on-surface-variant transition hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
            {visible ? concealLabel : revealLabel}
          </button>
        )}
      </div>
      <input
        id={id}
        name={name}
        type={isMasked ? 'password' : 'text'}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        aria-invalid={isInvalid}
        aria-describedby={note === undefined ? hintId : `${hintId} ${noteId}`}
        disabled={disabled}
        className={className}
      />
      <p
        id={hintId}
        className="mt-2 text-xs leading-relaxed text-on-surface-variant"
      >
        {hint}
      </p>
      {note !== undefined && (
        <p
          id={noteId}
          className="mt-2 rounded-lg border border-outline-variant bg-surface-container px-2.5 py-2 text-xs leading-relaxed text-on-surface-variant"
        >
          {note}
        </p>
      )}
      {isInvalid && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
