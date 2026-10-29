import { describe, expect, it } from 'vitest';
import { collectMintedCredentials, formatCredentialHandoff } from './setup-credentials';
import type { SetupBootstrapOutput } from './setup-bootstrap';

const bootstrapOutput: SetupBootstrapOutput = {
  projects: [{ slug: 'demo', tables: ['users'] }],
  apiKeys: [
    {
      apiKey: 'sfk_admin1.adminsecret',
      record: { id: 'admin1', name: 'sheetflare-setup-admin', projectSlug: null, scopes: ['admin:projects', 'admin:keys'] }
    },
    {
      apiKey: 'sfk_read1.readsecret',
      record: { id: 'read1', name: 'sheetflare-setup-read', projectSlug: 'demo', scopes: ['table:read'] }
    }
  ],
  skippedKeys: [],
  revokedKeys: []
};

describe('collectMintedCredentials', () => {
  it('lists the bootstrap token when setup generated it, followed by every key the bootstrap minted', () => {
    expect(collectMintedCredentials({
      generatedAdminBearerToken: 'generated-bootstrap-token',
      bootstrapOutput
    })).toEqual([
      {
        label: 'Bootstrap admin token (Worker secret ADMIN_BEARER_TOKEN; break-glass only)',
        value: 'generated-bootstrap-token'
      },
      {
        label: 'API key "sheetflare-setup-admin" (scopes: admin:projects, admin:keys)',
        value: 'sfk_admin1.adminsecret'
      },
      {
        label: 'API key "sheetflare-setup-read" (project: demo; scopes: table:read)',
        value: 'sfk_read1.readsecret'
      }
    ]);
  });

  it('omits credentials the operator already holds: an environment-supplied token and skipped keys', () => {
    expect(collectMintedCredentials({
      generatedAdminBearerToken: null,
      bootstrapOutput: { ...bootstrapOutput, apiKeys: [], skippedKeys: [{ name: 'sheetflare-setup-admin', id: 'admin1' }] }
    })).toEqual([]);
  });

  it('returns nothing when neither a token nor a bootstrap ran', () => {
    expect(collectMintedCredentials({ generatedAdminBearerToken: null, bootstrapOutput: null })).toEqual([]);
  });
});

describe('formatCredentialHandoff', () => {
  it('prints nothing when no credential was minted', () => {
    expect(formatCredentialHandoff([])).toEqual([]);
  });

  it('prints an explicit, labelled one-time block containing each secret exactly once', () => {
    const lines = formatCredentialHandoff([
      { label: 'Bootstrap admin token', value: 'token-value' },
      { label: 'API key "setup-admin"', value: 'sfk_a.b' }
    ]);
    const text = lines.join('\n');

    expect(text).toContain('SAVE THESE CREDENTIALS NOW');
    expect(text).toContain('shown once');
    expect(text).toContain('not saved');
    expect(text.match(/token-value/g)).toHaveLength(1);
    expect(text.match(/sfk_a\.b/g)).toHaveLength(1);
    expect(text).toContain('Bootstrap admin token');
    expect(text).toContain('API key "setup-admin"');
  });
});
