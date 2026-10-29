import type { SetupBootstrapOutput } from './setup-bootstrap';

export type MintedCredential = {
  label: string;
  value: string;
};

/**
 * Collects the secrets this run minted and the operator cannot read back later:
 * the bootstrap token (only when setup generated it, not when it came from the environment)
 * and the API keys the bootstrap just created. Skipped keys were not minted, so they have no value.
 */
export function collectMintedCredentials(options: {
  generatedAdminBearerToken: string | null;
  bootstrapOutput: SetupBootstrapOutput | null;
}): MintedCredential[] {
  const credentials: MintedCredential[] = [];

  if (options.generatedAdminBearerToken) {
    credentials.push({
      label: 'Bootstrap admin token (Worker secret ADMIN_BEARER_TOKEN; break-glass only)',
      value: options.generatedAdminBearerToken
    });
  }

  for (const { apiKey, record } of options.bootstrapOutput?.apiKeys ?? []) {
    const details = [
      ...(record.projectSlug ? [`project: ${record.projectSlug}`] : []),
      `scopes: ${record.scopes.join(', ')}`
    ].join('; ');
    credentials.push({ label: `API key "${record.name}" (${details})`, value: apiKey });
  }

  return credentials;
}

const handoffRule = '='.repeat(72);

/** Renders the single, explicit block that hands freshly minted secrets to the operator. */
export function formatCredentialHandoff(credentials: readonly MintedCredential[]): string[] {
  if (credentials.length === 0) {
    return [];
  }

  return [
    '',
    handoffRule,
    'SAVE THESE CREDENTIALS NOW. They are shown once.',
    handoffRule,
    ...credentials.flatMap((credential) => ['', `${credential.label}:`, `  ${credential.value}`]),
    '',
    'Setup has not saved these anywhere: not in sheetflare.setup.json, not in .sheetflare.setup.local.json.',
    'Copy them into your password manager before you close this terminal. Sign in to the admin UI',
    'with an admin API key. If one is lost, rerun setup with --bootstrap --rotate-keys to replace it.',
    handoffRule
  ];
}
