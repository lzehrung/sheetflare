export const requiredStagingSecrets = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY',
  'SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN'
] as const;

/** GitHub passes unset repository secrets as empty strings, so blank counts as missing. */
export function findMissingStagingSecrets(env: NodeJS.ProcessEnv) {
  return requiredStagingSecrets.filter((name) => (env[name]?.trim() ?? '').length === 0);
}

export function formatMissingStagingSecretsMessage(missing: readonly string[], docsUrl: string) {
  return [
    `Missing required staging deploy secrets: ${missing.join(', ')}.`,
    'Add each one under Settings > Secrets and variables > Actions > Repository secrets, then rerun this workflow.',
    `Where to get the values and how staging is set up: ${docsUrl}`
  ].join('\n');
}
