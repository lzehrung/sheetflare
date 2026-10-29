import { findMissingStagingSecrets, formatMissingStagingSecretsMessage } from './lib/staging-secrets';

const docsUrl = process.env.SHEETFLARE_STAGING_DOCS_URL?.trim()
  || 'https://github.com/lzehrung/sheetflare/blob/main/contributor-staging.md';

const missing = findMissingStagingSecrets(process.env);
if (missing.length > 0) {
  for (const name of missing) {
    console.error(`::error title=Missing repository secret::${name} is not set. See ${docsUrl}`);
  }
  console.error(formatMissingStagingSecretsMessage(missing, docsUrl));
  process.exit(1);
}

console.log('All required staging deploy secrets are present.');
