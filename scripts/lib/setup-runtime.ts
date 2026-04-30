import { getEnv } from './runtime';
import { createSetupLocalState, redactSetupLocalState, type SetupLocalState } from './setup-state';

export type ResolvedSetupRuntimeState = {
  googleClientEmail: string | null;
  apiUrl: string | null;
  adminUrl: string | null;
  adminBearerToken: string | null;
  adminUiUsername: string | null;
  adminUiPassword: string | null;
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
    apiUrl: resolveValue(localState?.apiUrl, getEnv('SHEETFLARE_BASE_URL')),
    adminUrl: resolveValue(localState?.adminUrl),
    adminBearerToken: resolveValue(
      localState?.adminBearerToken,
      getEnv('SHEETFLARE_ADMIN_CREDENTIAL'),
      getEnv('ADMIN_BEARER_TOKEN')
    ),
    adminUiUsername: resolveValue(localState?.adminUiUsername, getEnv('ADMIN_UI_USERNAME')),
    adminUiPassword: resolveValue(localState?.adminUiPassword, getEnv('ADMIN_UI_PASSWORD')),
    adminApiKey: resolveValue(localState?.adminApiKey, getEnv('SHEETFLARE_ADMIN_CREDENTIAL')),
    privateReadKey: resolveValue(localState?.privateReadKey, getEnv('SHEETFLARE_PRIVATE_READ_KEY')),
    mutationKey: resolveValue(localState?.mutationKey, getEnv('SHEETFLARE_MUTATION_KEY'))
  };
}

export function resolvePreferredAdminCredential(state: Pick<ResolvedSetupRuntimeState, 'adminApiKey' | 'adminBearerToken'>) {
  return resolveValue(state.adminApiKey, state.adminBearerToken);
}

export function summarizeSetupSecrets(options: {
  showSecrets: boolean;
  localStatePath: string | null;
  adminBearerToken: string | null;
  adminUiUsername: string | null;
  adminUiPassword: string | null;
  adminApiKey: string | null;
  privateReadKey: string | null;
  mutationKey: string | null;
}) {
  if (options.showSecrets) {
    return {
      adminBearerToken: options.adminBearerToken,
      adminUiUsername: options.adminUiUsername,
      adminUiPassword: options.adminUiPassword,
      adminApiKey: options.adminApiKey,
      privateReadKey: options.privateReadKey,
      mutationKey: options.mutationKey,
      localStatePath: options.localStatePath
    };
  }

  return {
    ...redactSetupLocalState(createSetupLocalState({
      adminBearerToken: options.adminBearerToken,
      adminUiUsername: options.adminUiUsername,
      adminUiPassword: options.adminUiPassword,
      adminApiKey: options.adminApiKey,
      privateReadKey: options.privateReadKey,
      mutationKey: options.mutationKey
    })),
    localStatePath: options.localStatePath
  };
}
