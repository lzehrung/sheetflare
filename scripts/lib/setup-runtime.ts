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

export type SetupSecretsSummary = {
  localStatePath: string | null;
  adminBearerToken?: string | null;
  adminApiKey?: string | null;
  privateReadKey?: string | null;
  mutationKey?: string | null;
};

export function summarizeSetupSecrets(options: {
  showSecrets: boolean;
  localStatePath: string | null;
  adminBearerToken: string | null;
  adminApiKey: string | null;
  privateReadKey: string | null;
  mutationKey: string | null;
}): SetupSecretsSummary {
  if (options.showSecrets) {
    return {
      adminBearerToken: options.adminBearerToken,
      adminApiKey: options.adminApiKey,
      privateReadKey: options.privateReadKey,
      mutationKey: options.mutationKey,
      localStatePath: options.localStatePath
    };
  }

  return {
    localStatePath: options.localStatePath
  };
}
