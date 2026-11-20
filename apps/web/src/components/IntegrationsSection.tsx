import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIntegrations } from '../hooks/useIntegrations';
import {
  bitrix24WebhookUrlSchema,
  connectEdoIntegration,
  connectKeyIntegration,
  connectTelegram,
  diadocCredentialsSchema,
  disconnectEdoIntegration,
  disconnectGoogle,
  disconnectKeyIntegration,
  disconnectTelegram,
  fetchGoogleAuthorizationUrl,
  getIntegrationErrorDetails,
  getProviderCredentialRejectionKey,
  getTelegramDisplayName,
  getWildberriesTokenExpiry,
  integrationsQueryKey,
  moyskladApiTokenSchema,
  oneCCredentialsSchema,
  oneCOdataUrlSchema,
  oneCPasswordSchema,
  oneCUsernameSchema,
  PROVIDER_AUTH_REQUIRED_CODE,
  sbisCredentialsSchema,
  telegramBotTokenSchema,
  type EdoIntegration,
  type EdoIntegrationProvider,
  type IntegrationErrorKind,
  type IntegrationOperation,
  type IntegrationStatus,
  type IntegrationsState,
  type GoogleIntegration,
  type KeyIntegrationConnectInput,
  type KeyIntegrationProvider,
  type OneCIntegration,
  type TelegramIntegration,
} from '../lib/integrations';
import {
  IntegrationIcon,
  type IntegrationLogoProvider,
} from './IntegrationIcon';
import { SecretField } from './SecretField';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-5 shadow-sm sm:p-6';

const CARD_CLASSES =
  'rounded-xl border border-outline-variant bg-surface p-4 sm:p-5';

const INPUT_CLASSES =
  'mt-2 block w-full rounded-xl border border-outline bg-surface-container px-4 py-2.5 font-mono text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60';

const PRIMARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/20 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60';

const DANGER_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-error/40 px-4 py-2.5 text-sm font-semibold text-error transition hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error disabled:cursor-not-allowed disabled:opacity-60';

const STATUS_CLASSES: Record<IntegrationStatus, string> = {
  active: 'border-success/30 bg-success/10 text-success',
  disconnected:
    'border-outline-variant bg-surface-container-high text-on-surface-variant',
  error: 'border-error/30 bg-error-container text-on-error-container',
};

const STATUS_DOT_CLASSES: Record<IntegrationStatus, string> = {
  active: 'bg-success',
  disconnected: 'bg-on-surface-variant/50',
  error: 'bg-error',
};

const STATUS_KEYS: Record<IntegrationStatus, string> = {
  active: 'settings.integrations.status.active',
  disconnected: 'settings.integrations.status.disconnected',
  error: 'settings.integrations.status.error',
};

/** Текст ошибки API: ключ `errors.*` переводим, свободный текст показываем как есть. */
const ERROR_KEYS: Record<IntegrationErrorKind, string> = {
  network: 'settings.integrations.errors.network',
  sessionExpired: 'settings.integrations.errors.sessionExpired',
  forbidden: 'settings.integrations.errors.forbidden',
  notFound: 'settings.integrations.errors.notFound',
  invalidToken: 'settings.integrations.errors.invalidToken',
  invalidCredentials: 'settings.integrations.errors.invalidCredentials',
  oauthUnavailable: 'settings.integrations.errors.oauthUnavailable',
  unavailable: 'settings.integrations.errors.unavailable',
  invalidResponse: 'settings.integrations.errors.invalidResponse',
  requestFailed: 'settings.integrations.errors.requestFailed',
  unknown: 'settings.integrations.errors.unknown',
};

function IntegrationStatusBadge({ status }: { status: IntegrationStatus }) {
  const { t } = useTranslation();

  return (
    <span
      aria-live="polite"
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_CLASSES[status]}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${STATUS_DOT_CLASSES[status]}`}
      />
      {t(STATUS_KEYS[status])}
    </span>
  );
}

function IntegrationErrorAlert({
  error,
  operation,
}: {
  error: unknown;
  operation: IntegrationOperation;
}) {
  const { t, i18n } = useTranslation();
  const details = getIntegrationErrorDetails(error, operation);
  const useKindMessage =
    details.kind === 'invalidToken' ||
    details.kind === 'invalidCredentials' ||
    details.kind === 'oauthUnavailable';
  const translatedServerMessage =
    details.serverMessage !== null &&
    details.serverMessage.startsWith('errors.') &&
    i18n.exists(details.serverMessage)
      ? t(details.serverMessage)
      : null;
  // Live-проверка ключей: провайдер отклонил секрет конкретной карточки —
  // показываем её формулировку вместо общего «Провайдер отклонил ключи».
  const rejectionKey =
    details.kind === 'invalidCredentials' &&
    details.serverMessage === PROVIDER_AUTH_REQUIRED_CODE
      ? getProviderCredentialRejectionKey(operation)
      : null;
  const message =
    rejectionKey !== null
      ? t(rejectionKey)
      : translatedServerMessage !== null && !useKindMessage
        ? translatedServerMessage
        : t(ERROR_KEYS[details.kind]);

  return (
    <div
      role="alert"
      className="mt-3 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm leading-relaxed text-on-error-container"
    >
      {message}
    </div>
  );
}

function IntegrationStateError({
  text,
}: {
  text: string | null | undefined;
}) {
  const { t, i18n } = useTranslation();

  if (text === null || text === undefined) {
    return null;
  }

  const message =
    text.startsWith('errors.') && i18n.exists(text)
      ? t(text)
      : t('settings.integrations.errors.providerError');

  return (
    <div
      role="alert"
      className="mt-3 rounded-xl border border-error/30 bg-error-container px-3 py-2.5 text-sm leading-relaxed text-on-error-container"
    >
      {message}
    </div>
  );
}

function IntegrationSkeleton() {
  const { t } = useTranslation();

  return (
    <div role="status" className="mt-5">
      <span className="sr-only">{t('settings.integrations.loading')}</span>
      <div aria-hidden="true" className="space-y-4">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="h-40 animate-pulse rounded-xl border border-outline-variant bg-surface-container-high"
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationCardHeader({
  provider,
  title,
  description,
  status,
  titleId,
}: {
  provider: IntegrationLogoProvider;
  title: string;
  description: string;
  status: IntegrationStatus;
  titleId: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-outline-variant bg-surface-container-high text-on-surface">
          <IntegrationIcon provider={provider} className="size-5" />
        </span>
        <div className="min-w-0">
          <h3
            id={titleId}
            className="font-display text-base font-bold text-on-surface"
          >
            {title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
            {description}
          </p>
        </div>
      </div>
      <IntegrationStatusBadge status={status} />
    </div>
  );
}

function ConnectedAccount({
  label,
  value,
  unknown,
}: {
  label: string;
  value: string | null;
  unknown: string;
}) {
  return (
    <div className="mt-4 rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-on-surface-variant">
        {label}
      </p>
      <p className="mt-1 break-all font-mono text-sm text-on-surface">
        {value ?? unknown}
      </p>
    </div>
  );
}

function TelegramIntegrationCard({
  integration,
  token,
  tokenError,
  notice,
  isConnecting,
  isDisconnecting,
  connectError,
  disconnectError,
  onTokenChange,
  onConnect,
  onDisconnect,
}: {
  integration: TelegramIntegration;
  token: string;
  tokenError: string | null;
  notice: string | null;
  isConnecting: boolean;
  isDisconnecting: boolean;
  connectError: unknown;
  disconnectError: unknown;
  onTokenChange: (value: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const isActive = integration.status === 'active';
  const displayName = getTelegramDisplayName(integration);

  return (
    <article
      aria-labelledby="telegram-integration-title"
      className={CARD_CLASSES}
    >
      <IntegrationCardHeader
        provider="telegram"
        title={t('settings.integrations.telegram.title')}
        description={t('settings.integrations.telegram.description')}
        status={integration.status}
        titleId="telegram-integration-title"
      />

      {integration.status === 'error' && (
        <IntegrationStateError text={integration.error} />
      )}

      {isActive ? (
        <>
          <ConnectedAccount
            label={t('settings.integrations.telegram.connectedAs')}
            value={displayName}
            unknown={t('settings.integrations.telegram.unknownBot')}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onDisconnect}
              disabled={isDisconnecting}
              aria-busy={isDisconnecting}
              className={DANGER_BUTTON_CLASSES}
            >
              {isDisconnecting
                ? t('settings.integrations.telegram.disconnecting')
                : t('settings.integrations.telegram.disconnect')}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {disconnectError !== null && (
            <IntegrationErrorAlert
              error={disconnectError}
              operation="telegramDisconnect"
            />
          )}
        </>
      ) : (
        <>
          <div className="mt-4">
            <label
              htmlFor="telegram-bot-token"
              className="block text-sm font-medium text-on-surface"
            >
              {t('settings.integrations.telegram.botToken')}
            </label>
            <input
              id="telegram-bot-token"
              name="botToken"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder={t(
                'settings.integrations.telegram.botTokenPlaceholder',
              )}
              aria-invalid={tokenError !== null}
              aria-describedby="telegram-bot-token-hint"
              disabled={isConnecting}
              className={INPUT_CLASSES}
            />
            <p
              id="telegram-bot-token-hint"
              className="mt-2 text-xs leading-relaxed text-on-surface-variant"
            >
              {t('settings.integrations.telegram.botTokenHint')}
            </p>
            {tokenError !== null && (
              <p role="alert" className="mt-2 text-sm text-error">
                {tokenError}
              </p>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onConnect}
              disabled={isConnecting || token.trim() === ''}
              aria-busy={isConnecting}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {isConnecting
                ? t('settings.integrations.telegram.connecting')
                : t('settings.integrations.telegram.connect')}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {connectError !== null && (
            <IntegrationErrorAlert
              error={connectError}
              operation="telegramConnect"
            />
          )}
        </>
      )}
    </article>
  );
}

function GoogleIntegrationCard({
  integration,
  notice,
  isRedirecting,
  isDisconnecting,
  connectError,
  disconnectError,
  onConnect,
  onDisconnect,
}: {
  integration: GoogleIntegration;
  notice: string | null;
  isRedirecting: boolean;
  isDisconnecting: boolean;
  connectError: unknown;
  disconnectError: unknown;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const isActive = integration.status === 'active';
  const email =
    integration.email === undefined || integration.email === null
      ? null
      : integration.email;

  return (
    <article aria-labelledby="google-integration-title" className={CARD_CLASSES}>
      <IntegrationCardHeader
        provider="google"
        title={t('settings.integrations.google.title')}
        description={t('settings.integrations.google.description')}
        status={integration.status}
        titleId="google-integration-title"
      />

      {integration.status === 'error' && (
        <IntegrationStateError text={integration.error} />
      )}

      {isActive ? (
        <>
          <ConnectedAccount
            label={t('settings.integrations.google.connectedAs')}
            value={email}
            unknown={t('settings.integrations.google.unknownEmail')}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onDisconnect}
              disabled={isDisconnecting}
              aria-busy={isDisconnecting}
              className={DANGER_BUTTON_CLASSES}
            >
              {isDisconnecting
                ? t('settings.integrations.google.disconnecting')
                : t('settings.integrations.google.disconnect')}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {disconnectError !== null && (
            <IntegrationErrorAlert
              error={disconnectError}
              operation="googleDisconnect"
            />
          )}
        </>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onConnect}
              disabled={isRedirecting}
              aria-busy={isRedirecting}
              className={PRIMARY_BUTTON_CLASSES}
            >
              <IntegrationIcon provider="google" className="size-4" />
              {isRedirecting
                ? t('settings.integrations.google.redirecting')
                : t('settings.integrations.google.connect')}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
            {t('settings.integrations.google.oauthHint')}
          </p>
          {connectError !== null && (
            <IntegrationErrorAlert
              error={connectError}
              operation="googleConnect"
            />
          )}
        </>
      )}
    </article>
  );
}

/**
 * Провайдеры с одним секретом (рендерятся через `ProviderKeyCard`). 1С
 * исключён: у него три поля и своя карточка.
 */
type SimpleKeyProvider = Exclude<KeyIntegrationProvider, '1c'>;

const KEY_CONNECT_OPERATIONS: Record<
  SimpleKeyProvider,
  IntegrationOperation
> = {
  ozon: 'ozonConnect',
  wildberries: 'wildberriesConnect',
  midjourney: 'midjourneyConnect',
  bitrix24: 'bitrix24Connect',
  moysklad: 'moyskladConnect',
};

const KEY_DISCONNECT_OPERATIONS: Record<
  SimpleKeyProvider,
  IntegrationOperation
> = {
  ozon: 'ozonDisconnect',
  wildberries: 'wildberriesDisconnect',
  midjourney: 'midjourneyDisconnect',
  bitrix24: 'bitrix24Disconnect',
  moysklad: 'moyskladDisconnect',
};

/**
 * Поле секрета в карточке провайдера: ключи i18n строятся как
 * `settings.integrations.<provider>.<label>`.
 */
interface KeyProviderFields {
  /** Суффиксы ключей i18n: подпись, placeholder и подсказка. */
  label: string;
  placeholder: string;
  hint: string;
  /** `name` и суффикс `id` поля ввода. */
  name: string;
  fieldSuffix: string;
  /**
   * Показывать ли переключатель «Показать»/«Скрыть»: значение маскируется в
   * любом случае, но вебхук Битрикс24 полезно сверить глазами.
   */
  revealable: boolean;
  inputMode?: 'url';
}

const KEY_PROVIDER_FIELDS: Record<SimpleKeyProvider, KeyProviderFields> = {
  ozon: {
    label: 'apiKey',
    placeholder: 'apiKeyPlaceholder',
    hint: 'apiKeyHint',
    name: 'apiKey',
    fieldSuffix: 'api-key',
    revealable: false,
  },
  wildberries: {
    label: 'apiToken',
    placeholder: 'apiTokenPlaceholder',
    hint: 'apiTokenHint',
    name: 'apiToken',
    fieldSuffix: 'api-token',
    revealable: false,
  },
  midjourney: {
    label: 'ttApiKey',
    placeholder: 'ttApiKeyPlaceholder',
    hint: 'ttApiKeyHint',
    name: 'apiKey',
    fieldSuffix: 'api-key',
    revealable: false,
  },
  bitrix24: {
    label: 'webhookUrl',
    placeholder: 'webhookUrlPlaceholder',
    hint: 'webhookUrlHint',
    name: 'webhookUrl',
    fieldSuffix: 'webhook-url',
    revealable: true,
    inputMode: 'url',
  },
  moysklad: {
    label: 'apiToken',
    placeholder: 'apiTokenPlaceholder',
    hint: 'apiTokenHint',
    name: 'apiToken',
    fieldSuffix: 'api-token',
    revealable: false,
  },
};

/** Ключ ошибки формата секрета в локали `<prefix>.<key>`. */
const SECRET_ERROR_KEYS: Record<SimpleKeyProvider, string> = {
  ozon: 'invalidFields',
  wildberries: 'invalidFields',
  midjourney: 'invalidFields',
  bitrix24: 'invalidWebhookUrl',
  moysklad: 'invalidToken',
};

/**
 * Проверка формата секрета до запроса к API: Битрикс24 принимает только
 * абсолютный `https://`-вебхук, МойСклад — токен разумной длины. Формат
 * ключей Ozon/Wildberries/Midjourney проверяет провайдер.
 */
const SECRET_VALIDATORS: Record<
  SimpleKeyProvider,
  (value: string) => boolean
> = {
  ozon: () => true,
  wildberries: () => true,
  midjourney: () => true,
  bitrix24: (value) => bitrix24WebhookUrlSchema.safeParse(value).success,
  moysklad: (value) => moyskladApiTokenSchema.safeParse(value).success,
};

/** Тело `POST /integrations/<provider>`: набор полей зависит от провайдера. */
function buildKeyConnectInput(
  provider: SimpleKeyProvider,
  clientId: string,
  secret: string,
): KeyIntegrationConnectInput {
  switch (provider) {
    case 'ozon':
      return { provider, clientId, apiKey: secret };
    case 'wildberries':
    case 'moysklad':
      return { provider, apiToken: secret };
    case 'bitrix24':
      return { provider, webhookUrl: secret };
    case 'midjourney':
      return { provider, apiKey: secret };
  }
}

function formatIntegrationDate(value: string, language: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    language.startsWith('en') ? 'en-US' : 'ru-RU',
    { dateStyle: 'medium' },
  ).format(date);
}

function ProviderKeyCard({
  provider,
  integration,
  onRefresh,
}: {
  provider: SimpleKeyProvider;
  integration: IntegrationsState[SimpleKeyProvider] | undefined;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [isSecretVisible, setIsSecretVisible] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isOzon = provider === 'ozon';
  const isWildberries = provider === 'wildberries';
  const status = integration?.status ?? 'disconnected';
  const isActive = status === 'active';
  const displayClientId =
    integration !== undefined && 'clientId' in integration
      ? (integration.clientId ?? null)
      : null;
  const expiry =
    integration !== undefined && 'tokenExpiresAt' in integration
      ? (getWildberriesTokenExpiry(integration) ?? null)
      : null;
  const prefix = `settings.integrations.${provider}`;
  const fields = KEY_PROVIDER_FIELDS[provider];
  const secretLabelKey = `${prefix}.${fields.label}`;
  const secretPlaceholderKey = `${prefix}.${fields.placeholder}`;
  const secretHintKey = `${prefix}.${fields.hint}`;
  const secretFieldId = `${provider}-${fields.fieldSuffix}`;

  const connectMutation = useMutation({
    mutationFn: (input: KeyIntegrationConnectInput) =>
      connectKeyIntegration(input),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: () => {
      setSecret('');
      setIsSecretVisible(false);
      setFieldError(null);
      setNotice(t(`${prefix}.connected`));
      onRefresh();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectKeyIntegration(provider),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: () => {
      setNotice(t(`${prefix}.disconnected`));
      onRefresh();
    },
  });

  function handleConnect(): void {
    const trimmedSecret = secret.trim();
    const trimmedClientId = clientId.trim();

    if (trimmedSecret === '' || (isOzon && trimmedClientId === '')) {
      setFieldError(t(`${prefix}.invalidFields`));
      return;
    }

    if (!SECRET_VALIDATORS[provider](trimmedSecret)) {
      setFieldError(t(`${prefix}.${SECRET_ERROR_KEYS[provider]}`));
      return;
    }

    setFieldError(null);
    connectMutation.mutate(
      buildKeyConnectInput(provider, trimmedClientId, trimmedSecret),
    );
  }

  function handleClientIdChange(value: string): void {
    setClientId(value);
    setFieldError(null);
    connectMutation.reset();
  }

  function handleSecretChange(value: string): void {
    setSecret(value);
    setFieldError(null);
    connectMutation.reset();
  }

  return (
    <article
      aria-labelledby={`${provider}-integration-title`}
      className={CARD_CLASSES}
    >
      <IntegrationCardHeader
        provider={provider}
        title={t(`${prefix}.title`)}
        description={t(`${prefix}.description`)}
        status={status}
        titleId={`${provider}-integration-title`}
      />

      {status === 'error' && (
        <IntegrationStateError
          text={
            integration !== undefined && integration.error !== undefined
              ? integration.error
              : null
          }
        />
      )}

      {isActive ? (
        <>
          <ConnectedAccount
            label={t(`${prefix}.connectedAs`)}
            value={isOzon ? displayClientId : t(`${prefix}.keySaved`)}
            unknown={t('settings.integrations.providers.keySaved')}
          />
          {isWildberries && (
            <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
              {expiry === null
                ? t(`${prefix}.expiryWarning`)
                : t(`${prefix}.expiresAt`, {
                    date: formatIntegrationDate(expiry, i18n.language),
                  })}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              aria-busy={disconnectMutation.isPending}
              className={DANGER_BUTTON_CLASSES}
            >
              {disconnectMutation.isPending
                ? t(`${prefix}.disconnecting`)
                : t(`${prefix}.disconnect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {disconnectMutation.isError && (
            <IntegrationErrorAlert
              error={disconnectMutation.error}
              operation={KEY_DISCONNECT_OPERATIONS[provider]}
            />
          )}
        </>
      ) : (
        <>
          {isOzon && (
            <div className="mt-4">
              <label
                htmlFor={`${provider}-client-id`}
                className="block text-sm font-medium text-on-surface"
              >
                {t(`${prefix}.clientId`)}
              </label>
              <input
                id={`${provider}-client-id`}
                name="clientId"
                type="text"
                autoComplete="off"
                value={clientId}
                onChange={(event) =>
                  handleClientIdChange(event.target.value)
                }
                placeholder={t(`${prefix}.clientIdPlaceholder`)}
                disabled={connectMutation.isPending}
                className={INPUT_CLASSES}
              />
            </div>
          )}

          <SecretField
            id={secretFieldId}
            name={fields.name}
            label={t(secretLabelKey)}
            hint={t(secretHintKey)}
            note={
              provider === 'bitrix24'
                ? t('settings.integrations.bitrix24.webhookUrlSecurityHint')
                : undefined
            }
            placeholder={t(secretPlaceholderKey)}
            value={secret}
            onValueChange={handleSecretChange}
            visible={isSecretVisible}
            onVisibleChange={setIsSecretVisible}
            revealable={fields.revealable}
            revealLabel={t('settings.integrations.secret.show')}
            concealLabel={t('settings.integrations.secret.hide')}
            inputMode={fields.inputMode}
            disabled={connectMutation.isPending}
            error={fieldError}
            className={INPUT_CLASSES}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connectMutation.isPending}
              aria-busy={connectMutation.isPending}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {connectMutation.isPending
                ? t(`${prefix}.connecting`)
                : t(`${prefix}.connect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {connectMutation.isError && (
            <IntegrationErrorAlert
              error={connectMutation.error}
              operation={KEY_CONNECT_OPERATIONS[provider]}
            />
          )}
        </>
      )}
    </article>
  );
}

/**
 * Карточка «1С:Предприятие» (Sprint 32). У провайдера три поля, поэтому она
 * не использует generic `ProviderKeyCard`: OData URL и логин — обычные поля,
 * пароль — `SecretField` с маскировкой.
 */
function OneCIntegrationCard({
  integration,
  onRefresh,
}: {
  integration: OneCIntegration;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [odataUrl, setOdataUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [odataUrlError, setOdataUrlError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isActive = integration.status === 'active';
  const prefix = 'settings.integrations.oneC';

  const connectMutation = useMutation({
    mutationFn: (input: KeyIntegrationConnectInput) =>
      connectKeyIntegration(input),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: () => {
      setPassword('');
      setPasswordVisible(false);
      setOdataUrlError(null);
      setUsernameError(null);
      setPasswordError(null);
      setNotice(t(`${prefix}.connected`));
      onRefresh();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectKeyIntegration('1c'),
    onMutate: () => {
      setNotice(null);
    },
    onSuccess: () => {
      setNotice(t(`${prefix}.disconnected`));
      onRefresh();
    },
  });

  function handleConnect(): void {
    const odataUrlResult = oneCOdataUrlSchema.safeParse(odataUrl);
    const usernameResult = oneCUsernameSchema.safeParse(username);
    const passwordResult = oneCPasswordSchema.safeParse(password);
    const credentials = oneCCredentialsSchema.safeParse({
      odataUrl,
      username,
      password,
    });

    setOdataUrlError(
      odataUrlResult.success ? null : t(`${prefix}.invalidOdataUrl`),
    );
    setUsernameError(
      usernameResult.success ? null : t(`${prefix}.invalidUsername`),
    );
    setPasswordError(
      passwordResult.success ? null : t(`${prefix}.invalidPassword`),
    );

    if (!credentials.success) {
      return;
    }

    setNotice(null);
    connectMutation.mutate({ provider: '1c', ...credentials.data });
  }

  function handleFieldChange(
    field: 'odataUrl' | 'username' | 'password',
    value: string,
  ): void {
    if (field === 'odataUrl') {
      setOdataUrl(value);
      setOdataUrlError(null);
    } else if (field === 'username') {
      setUsername(value);
      setUsernameError(null);
    } else {
      setPassword(value);
      setPasswordError(null);
    }

    connectMutation.reset();
  }

  return (
    <article aria-labelledby="1c-integration-title" className={CARD_CLASSES}>
      <IntegrationCardHeader
        provider="1c"
        title={t(`${prefix}.title`)}
        description={t(`${prefix}.description`)}
        status={integration.status}
        titleId="1c-integration-title"
      />

      {integration.status === 'error' && (
        <IntegrationStateError text={integration.error} />
      )}

      {isActive ? (
        <>
          <ConnectedAccount
            label={t(`${prefix}.odataUrl`)}
            value={integration.odataUrl ?? null}
            unknown={t('settings.integrations.providers.keySaved')}
          />
          <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
            {t(`${prefix}.keySaved`)}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              aria-busy={disconnectMutation.isPending}
              className={DANGER_BUTTON_CLASSES}
            >
              {disconnectMutation.isPending
                ? t(`${prefix}.disconnecting`)
                : t(`${prefix}.disconnect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {disconnectMutation.isError && (
            <IntegrationErrorAlert
              error={disconnectMutation.error}
              operation="1cDisconnect"
            />
          )}
        </>
      ) : (
        <>
          <div className="mt-4">
            <label
              htmlFor="1c-odata-url"
              className="block text-sm font-medium text-on-surface"
            >
              {t(`${prefix}.odataUrl`)}
            </label>
            <input
              id="1c-odata-url"
              name="odataUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={odataUrl}
              onChange={(event) =>
                handleFieldChange('odataUrl', event.target.value)
              }
              placeholder={t(`${prefix}.odataUrlPlaceholder`)}
              aria-invalid={odataUrlError !== null}
              aria-describedby="1c-odata-url-hint"
              disabled={connectMutation.isPending}
              className={INPUT_CLASSES}
            />
            <p
              id="1c-odata-url-hint"
              className="mt-2 text-xs leading-relaxed text-on-surface-variant"
            >
              {t(`${prefix}.odataUrlHint`)}
            </p>
            {odataUrlError !== null && (
              <p role="alert" className="mt-2 text-sm text-error">
                {odataUrlError}
              </p>
            )}
          </div>

          <div className="mt-4">
            <label
              htmlFor="1c-username"
              className="block text-sm font-medium text-on-surface"
            >
              {t(`${prefix}.username`)}
            </label>
            <input
              id="1c-username"
              name="username"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(event) =>
                handleFieldChange('username', event.target.value)
              }
              placeholder={t(`${prefix}.usernamePlaceholder`)}
              aria-invalid={usernameError !== null}
              disabled={connectMutation.isPending}
              className={INPUT_CLASSES}
            />
            {usernameError !== null && (
              <p role="alert" className="mt-2 text-sm text-error">
                {usernameError}
              </p>
            )}
          </div>

          <SecretField
            id="1c-password"
            name="password"
            label={t(`${prefix}.password`)}
            hint={t(`${prefix}.passwordHint`)}
            placeholder={t(`${prefix}.passwordPlaceholder`)}
            value={password}
            onValueChange={(value) => handleFieldChange('password', value)}
            visible={passwordVisible}
            onVisibleChange={setPasswordVisible}
            revealable={false}
            revealLabel={t('settings.integrations.secret.show')}
            concealLabel={t('settings.integrations.secret.hide')}
            disabled={connectMutation.isPending}
            error={passwordError}
            className={INPUT_CLASSES}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connectMutation.isPending}
              aria-busy={connectMutation.isPending}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {connectMutation.isPending
                ? t(`${prefix}.connecting`)
                : t(`${prefix}.connect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {connectMutation.isError && (
            <IntegrationErrorAlert
              error={connectMutation.error}
              operation="1cConnect"
            />
          )}
        </>
      )}
    </article>
  );
}

/**
 * ЭДО-провайдеры (Sprint 41): у Диадока три поля, у СБИС два — отдельная
 * карточка с Zod-валидацией обеих форм до запроса к API.
 */
function EdoIntegrationCard({
  provider,
  integration,
  onRefresh,
}: {
  provider: EdoIntegrationProvider;
  integration: EdoIntegration;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const prefix = `settings.integrations.${provider}`;
  const [apiKey, setApiKey] = useState('');
  const [boxId, setBoxId] = useState('');
  const [token, setToken] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isActive = integration.status === 'active';
  const connectOperation =
    provider === 'diadoc' ? 'diadocConnect' : 'sbisConnect';
  const disconnectOperation =
    provider === 'diadoc' ? 'diadocDisconnect' : 'sbisDisconnect';

  const connectMutation = useMutation({
    mutationFn: (input: Parameters<typeof connectEdoIntegration>[0]) =>
      connectEdoIntegration(input),
    onMutate: () => {
      setNotice(null);
      setFieldError(null);
    },
    onSuccess: () => {
      setApiKey('');
      setToken('');
      setNotice(t(`${prefix}.connected`));
      onRefresh();
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => disconnectEdoIntegration(provider),
    onMutate: () => setNotice(null),
    onSuccess: () => {
      setNotice(t(`${prefix}.disconnected`));
      onRefresh();
    },
  });

  function handleConnect(): void {
    if (provider === 'diadoc') {
      const parsed = diadocCredentialsSchema.safeParse({ apiKey, boxId, token });

      if (!parsed.success) {
        setFieldError(t(`${prefix}.invalidFields`));
        return;
      }

      connectMutation.mutate({ provider, ...parsed.data });
      return;
    }

    const parsed = sbisCredentialsSchema.safeParse({ boxId, token });

    if (!parsed.success) {
      setFieldError(t(`${prefix}.invalidFields`));
      return;
    }

    connectMutation.mutate({ provider, ...parsed.data });
  }

  return (
    <article
      aria-labelledby={`${provider}-integration-title`}
      className={CARD_CLASSES}
    >
      <IntegrationCardHeader
        provider={provider}
        title={t(`${prefix}.title`)}
        description={t(`${prefix}.description`)}
        status={integration.status}
        titleId={`${provider}-integration-title`}
      />

      {integration.status === 'error' && (
        <IntegrationStateError text={integration.error} />
      )}

      {isActive ? (
        <>
          <ConnectedAccount
            label={t(`${prefix}.boxId`)}
            value={integration.boxId ?? null}
            unknown={t('settings.integrations.providers.keySaved')}
          />
          <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
            {t(`${prefix}.keySaved`)}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              aria-busy={disconnectMutation.isPending}
              className={DANGER_BUTTON_CLASSES}
            >
              {disconnectMutation.isPending
                ? t(`${prefix}.disconnecting`)
                : t(`${prefix}.disconnect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {disconnectMutation.isError && (
            <IntegrationErrorAlert
              error={disconnectMutation.error}
              operation={disconnectOperation}
            />
          )}
        </>
      ) : (
        <>
          {provider === 'diadoc' && (
            <SecretField
              id="diadoc-api-key"
              name="apiKey"
              label={t(`${prefix}.apiKey`)}
              hint={t(`${prefix}.apiKeyHint`)}
              placeholder={t(`${prefix}.apiKeyPlaceholder`)}
              value={apiKey}
              onValueChange={setApiKey}
              visible={apiKeyVisible}
              onVisibleChange={setApiKeyVisible}
              revealable
              revealLabel={t('settings.integrations.secret.show')}
              concealLabel={t('settings.integrations.secret.hide')}
              disabled={connectMutation.isPending}
              className={INPUT_CLASSES}
            />
          )}

          <div className="mt-4">
            <label
              htmlFor={`${provider}-box-id`}
              className="block text-sm font-medium text-on-surface"
            >
              {t(`${prefix}.boxId`)}
            </label>
            <input
              id={`${provider}-box-id`}
              name="boxId"
              autoComplete="off"
              spellCheck={false}
              value={boxId}
              onChange={(event) => setBoxId(event.target.value)}
              placeholder={t(`${prefix}.boxIdPlaceholder`)}
              disabled={connectMutation.isPending}
              className={INPUT_CLASSES}
            />
            <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
              {t(`${prefix}.boxIdHint`)}
            </p>
          </div>

          <SecretField
            id={`${provider}-token`}
            name="token"
            label={t(`${prefix}.token`)}
            hint={t(`${prefix}.tokenHint`)}
            placeholder={t(`${prefix}.tokenPlaceholder`)}
            value={token}
            onValueChange={setToken}
            visible={tokenVisible}
            onVisibleChange={setTokenVisible}
            revealable
            revealLabel={t('settings.integrations.secret.show')}
            concealLabel={t('settings.integrations.secret.hide')}
            disabled={connectMutation.isPending}
            className={INPUT_CLASSES}
          />

          {fieldError !== null && (
            <p role="alert" className="mt-3 text-sm text-error">
              {fieldError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connectMutation.isPending}
              aria-busy={connectMutation.isPending}
              className={PRIMARY_BUTTON_CLASSES}
            >
              {connectMutation.isPending
                ? t(`${prefix}.connecting`)
                : t(`${prefix}.connect`)}
            </button>
            {notice !== null && (
              <p role="status" className="text-sm font-medium text-success">
                {notice}
              </p>
            )}
          </div>
          {connectMutation.isError && (
            <IntegrationErrorAlert
              error={connectMutation.error}
              operation={connectOperation}
            />
          )}
        </>
      )}
    </article>
  );
}

export function IntegrationsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const integrationsQuery = useIntegrations();
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);

  function refreshIntegrations(): void {
    void queryClient.invalidateQueries({
      queryKey: integrationsQueryKey,
    });
  }

  const connectTelegramMutation = useMutation({
    mutationFn: connectTelegram,
    onMutate: () => {
      setTelegramNotice(null);
    },
    onSuccess: () => {
      setToken('');
      setTokenError(null);
      setTelegramNotice(t('settings.integrations.telegram.connected'));
      refreshIntegrations();
    },
  });

  const disconnectTelegramMutation = useMutation({
    mutationFn: disconnectTelegram,
    onMutate: () => {
      setTelegramNotice(null);
    },
    onSuccess: () => {
      setTelegramNotice(t('settings.integrations.telegram.disconnected'));
      refreshIntegrations();
    },
  });

  const googleAuthMutation = useMutation({
    mutationFn: fetchGoogleAuthorizationUrl,
    onMutate: () => {
      setGoogleNotice(null);
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });

  const disconnectGoogleMutation = useMutation({
    mutationFn: disconnectGoogle,
    onMutate: () => {
      setGoogleNotice(null);
    },
    onSuccess: () => {
      setGoogleNotice(t('settings.integrations.google.disconnected'));
      refreshIntegrations();
    },
  });

  function handleTelegramConnect(): void {
    const parsed = telegramBotTokenSchema.safeParse(token);

    if (!parsed.success) {
      setTokenError(t('settings.integrations.telegram.invalidFormat'));
      return;
    }

    setTokenError(null);
    connectTelegramMutation.mutate(parsed.data);
  }

  function handleTelegramTokenChange(value: string): void {
    setToken(value);
    setTokenError(null);
    connectTelegramMutation.reset();
  }

  const data = integrationsQuery.data;

  return (
    <section
      aria-labelledby="integrations-title"
      aria-describedby="integrations-description"
      className={SECTION_CLASSES}
    >
      <div className="min-w-0 max-w-2xl">
        <h2
          id="integrations-title"
          className="font-display text-lg font-bold text-on-surface"
        >
          {t('settings.integrations.title')}
        </h2>
        <p
          id="integrations-description"
          className="mt-2 text-sm leading-relaxed text-on-surface-variant"
        >
          {t('settings.integrations.description')}
        </p>
      </div>

      {integrationsQuery.isPending ? (
        <IntegrationSkeleton />
      ) : integrationsQuery.isError || data === undefined ? (
        <div className="mt-5">
          <IntegrationErrorAlert
            error={integrationsQuery.error}
            operation="load"
          />
          <button
            type="button"
            onClick={() => {
              void integrationsQuery.refetch();
            }}
            className="mt-3 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('settings.integrations.retry')}
          </button>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <TelegramIntegrationCard
            integration={data.telegram}
            token={token}
            tokenError={tokenError}
            notice={telegramNotice}
            isConnecting={connectTelegramMutation.isPending}
            isDisconnecting={disconnectTelegramMutation.isPending}
            connectError={
              connectTelegramMutation.isError
                ? connectTelegramMutation.error
                : null
            }
            disconnectError={
              disconnectTelegramMutation.isError
                ? disconnectTelegramMutation.error
                : null
            }
            onTokenChange={handleTelegramTokenChange}
            onConnect={handleTelegramConnect}
            onDisconnect={() => disconnectTelegramMutation.mutate()}
          />

          <GoogleIntegrationCard
            integration={data.google}
            notice={googleNotice}
            isRedirecting={googleAuthMutation.isPending}
            isDisconnecting={disconnectGoogleMutation.isPending}
            connectError={
              googleAuthMutation.isError ? googleAuthMutation.error : null
            }
            disconnectError={
              disconnectGoogleMutation.isError
                ? disconnectGoogleMutation.error
                : null
            }
            onConnect={() => googleAuthMutation.mutate()}
            onDisconnect={() => disconnectGoogleMutation.mutate()}
          />

          <div className="border-t border-outline-variant pt-5">
            <h3 className="font-display text-base font-bold text-on-surface">
              {t('settings.integrations.providers.title')}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-on-surface-variant">
              {t('settings.integrations.providers.description')}
            </p>
            <div className="mt-4 space-y-4">
              <ProviderKeyCard
                provider="ozon"
                integration={data.ozon}
                onRefresh={refreshIntegrations}
              />
              <ProviderKeyCard
                provider="wildberries"
                integration={data.wildberries}
                onRefresh={refreshIntegrations}
              />
              <ProviderKeyCard
                provider="midjourney"
                integration={data.midjourney}
                onRefresh={refreshIntegrations}
              />
              <ProviderKeyCard
                provider="bitrix24"
                integration={data.bitrix24}
                onRefresh={refreshIntegrations}
              />
              <ProviderKeyCard
                provider="moysklad"
                integration={data.moysklad}
                onRefresh={refreshIntegrations}
              />
              <OneCIntegrationCard
                integration={data.onec}
                onRefresh={refreshIntegrations}
              />
              <EdoIntegrationCard
                provider="diadoc"
                integration={data.diadoc}
                onRefresh={refreshIntegrations}
              />
              <EdoIntegrationCard
                provider="sbis"
                integration={data.sbis}
                onRefresh={refreshIntegrations}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
