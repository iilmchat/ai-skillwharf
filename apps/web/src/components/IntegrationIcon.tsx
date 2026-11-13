import type { IntegrationProvider } from '../lib/integrations';

/** Иконки каналов: узнаваемые, без внешних ассетов и сетевых запросов. */
export function IntegrationIcon({
  provider,
  className = 'size-5',
}: {
  provider: IntegrationProvider;
  className?: string;
}) {
  if (provider === 'telegram') {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
      >
        <path d="M21.9 3.4a1 1 0 0 0-1-.2L2.6 10.5c-.9.35-.84 1.64.08 1.93l4.4 1.4 1.66 4.95c.2.6.95.78 1.4.33l2.36-2.36 4.1 3.03c.5.37 1.22.1 1.35-.5l3.1-14.6a1 1 0 0 0-.15-.88ZM9.5 13.1l8.2-6-6.2 6.85-.15 3.04-1.85-3.9Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className}>
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.79-.07-1.55-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.57-5.17 3.57-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l3.99-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.28 6.61l3.99 3.1C6.22 6.87 8.87 4.76 12 4.76Z"
      />
    </svg>
  );
}
