import { describe, expect, it } from 'vitest';
import {
  findMissingStagingSecrets,
  formatMissingStagingSecretsMessage,
  requiredStagingSecrets
} from './staging-secrets';

const completeEnv = {
  CLOUDFLARE_API_TOKEN: 'token',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
  SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN: 'bearer'
} satisfies NodeJS.ProcessEnv;

describe('findMissingStagingSecrets', () => {
  it('reports nothing when every secret is present', () => {
    expect(findMissingStagingSecrets(completeEnv)).toEqual([]);
  });

  it.each(requiredStagingSecrets)('names %s when it is the only secret missing', (name) => {
    const env = Object.fromEntries(Object.entries(completeEnv).filter(([key]) => key !== name));

    expect(findMissingStagingSecrets(env)).toEqual([name]);
  });

  it('treats blank and whitespace-only values as missing, as GitHub passes unset secrets as empty strings', () => {
    expect(findMissingStagingSecrets({
      ...completeEnv,
      CLOUDFLARE_API_TOKEN: '',
      SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN: '   '
    })).toEqual(['CLOUDFLARE_API_TOKEN', 'SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN']);
  });

  it('names every secret when none are configured', () => {
    expect(findMissingStagingSecrets({})).toEqual([...requiredStagingSecrets]);
  });
});

describe('formatMissingStagingSecretsMessage', () => {
  it('lists each missing secret and links to the setup docs', () => {
    const message = formatMissingStagingSecretsMessage(
      ['SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY', 'SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN'],
      'https://example.test/contributor-staging.md'
    );

    expect(message).toContain('SHEETFLARE_STAGING_GOOGLE_PRIVATE_KEY');
    expect(message).toContain('SHEETFLARE_STAGING_ADMIN_BEARER_TOKEN');
    expect(message).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(message).toContain('Settings > Secrets and variables > Actions');
    expect(message).toContain('https://example.test/contributor-staging.md');
  });
});
