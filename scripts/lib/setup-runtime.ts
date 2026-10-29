import { getEnv } from './runtime';
import type { SetupLocalState } from './setup-state';
import { getNamedGoogleCredentialsStatus, type GoogleCredentialSourceStatus } from './setup-google';

export type ResolvedSetupRuntimeState = {
  googleClientEmail: string | null;
  namedGoogleCredentials: GoogleCredentialSourceStatus;
  apiUrl: string | null;
  adminBearerToken: string | null;
  adminApiKey: string | null;
  privateReadKey: string | null;
  mutationKey: string | null;
};

function resolveValue(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

export function resolveSetupRuntimeState(localState: SetupLocalState | null): ResolvedSetupRuntimeState {
  return {
    googleClientEmail: resolveValue(localState?.googleClientEmail, getEnv('GOOGLE_CLIENT_EMAIL')),
    namedGoogleCredentials: getNamedGoogleCredentialsStatus(getEnv('GOOGLE_CREDENTIALS_JSON')),
    apiUrl: resolveValue(localState?.apiUrl, getEnv('SHEETFLARE_BASE_URL')),
    adminBearerToken: resolveValue(
      getEnv('SHEETFLARE_ADMIN_CREDENTIAL'),
      getEnv('ADMIN_BEARER_TOKEN')
    ),
    adminApiKey: resolveValue(getEnv('SHEETFLARE_ADMIN_CREDENTIAL')),
    privateReadKey: resolveValue(getEnv('SHEETFLARE_PRIVATE_READ_KEY')),
    mutationKey: resolveValue(getEnv('SHEETFLARE_MUTATION_KEY'))
  };
}

export function mergeSetupRuntimeState(
  base: ResolvedSetupRuntimeState,
  updates: Partial<Omit<ResolvedSetupRuntimeState, 'namedGoogleCredentials'>>
): ResolvedSetupRuntimeState {
  return {
    ...base,
    googleClientEmail: resolveValue(updates.googleClientEmail, base.googleClientEmail),
    apiUrl: resolveValue(updates.apiUrl, base.apiUrl),
    adminBearerToken: resolveValue(updates.adminBearerToken, base.adminBearerToken),
    adminApiKey: resolveValue(updates.adminApiKey, base.adminApiKey),
    privateReadKey: resolveValue(updates.privateReadKey, base.privateReadKey),
    mutationKey: resolveValue(updates.mutationKey, base.mutationKey)
  };
}

export function resolvePreferredAdminCredential(state: Pick<ResolvedSetupRuntimeState, 'adminApiKey' | 'adminBearerToken'>) {
  return resolveValue(state.adminApiKey, state.adminBearerToken);
}

/**
 * Scoped API keys are minted as `sfk_<uuid>.<64 hex>` and the gateway accepts no other shape (apps/api parseApiKey).
 * No shared parser is exported from @sheetflare/contracts, so the setup runtime mirrors that shape here.
 */
const apiKeyCredentialPattern = /^sfk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

// Runtime resolution copies SHEETFLARE_ADMIN_CREDENTIAL into both fields. After --apply-secrets
// replaces the bootstrap token, any field still holding the superseded bootstrap token must follow it;
// otherwise watch registration, smoke, and verify keep sending the old token.
// A scoped API key is never a bootstrap token, so it is never superseded and adminApiKey keeps it.
export function replaceSupersededAdminCredential(
  credentials: Pick<ResolvedSetupRuntimeState, 'adminApiKey' | 'adminBearerToken'>,
  appliedAdminBearerToken: string
): Pick<ResolvedSetupRuntimeState, 'adminApiKey' | 'adminBearerToken'> {
  const previousBootstrapToken = credentials.adminBearerToken;
  let supersededToken: string | null = null;
  if (
    previousBootstrapToken !== null
    && previousBootstrapToken !== appliedAdminBearerToken
    && !apiKeyCredentialPattern.test(previousBootstrapToken.trim())
  ) {
    supersededToken = previousBootstrapToken;
  }

  let adminApiKey = credentials.adminApiKey;
  if (supersededToken !== null && adminApiKey === supersededToken) {
    adminApiKey = appliedAdminBearerToken;
  }

  return {
    adminApiKey,
    adminBearerToken: appliedAdminBearerToken
  };
}
