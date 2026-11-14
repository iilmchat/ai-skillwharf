/** Блок кода из ответа агента: подпись языка и горизонтальный скролл. */
export function MessageCodeBlock({
  language,
  code,
  label,
}: {
  language: string;
  code: string;
  label: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container">
      {language !== '' && (
        <div className="border-b border-outline-variant bg-surface-container-high px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
          {language}
        </div>
      )}
      <pre
        aria-label={label}
        tabIndex={0}
        className="max-h-96 overflow-auto p-3 text-xs leading-relaxed text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <code className="whitespace-pre font-mono">{code}</code>
      </pre>
    </div>
  );
}
