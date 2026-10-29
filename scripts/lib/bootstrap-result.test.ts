import { describe, expect, it } from 'vitest';
import type { AdminCreateApiKeyResult } from '@sheetflare/contracts';
import { BootstrapApiKeysError } from './bootstrap-keys';
import { finishBootstrapKeys } from './bootstrap-result';
import { parseBootstrapOutput } from './setup-bootstrap';

const createdKey: AdminCreateApiKeyResult = {
  apiKey: 'sfk_11111111-1111-4111-8111-111111111111.secretsecretsecretsecret',
  record: {
    id: '11111111-1111-4111-8111-111111111111',
    projectSlug: 'demo',
    name: 'demo-read',
    scopes: ['table:read'],
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null
  }
};

describe('finishBootstrapKeys', () => {
  it('prints the full result marker for keys created before a failure, then rejects', async () => {
    const lines: string[] = [];

    await expect(finishBootstrapKeys({
      projects: [{ slug: 'demo', tables: ['users'] }],
      showSecrets: false,
      includeResultMarker: true,
      writeLine: (line) => {
        lines.push(line);
      },
      loadKeys: async () => {
        throw new BootstrapApiKeysError('create failed', {
          created: [createdKey],
          skipped: [],
          revoked: []
        });
      }
    })).rejects.toThrow('create failed');

    const stdout = lines.join('\n');
    expect(lines[0]).not.toContain(createdKey.apiKey);
    expect(parseBootstrapOutput(stdout).apiKeys.map((entry) => entry.apiKey)).toEqual([createdKey.apiKey]);
  });
});
