import type { ApiKeyPrincipal } from '@sheetflare/contracts';

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type ApiKeyFixture = {
  id: string;
  secret: string;
  /** SHA-256 hex digest of the secret, which is what the control plane stores and compares. */
  hash: string;
  /** The full `sfk_<id>.<secret>` credential in the format the control plane mints. */
  credential: string;
  authorization: string;
  record: ApiKeyPrincipal;
};

async function createApiKeyFixture(
  seed: number,
  record: Pick<ApiKeyPrincipal, 'projectSlug' | 'name' | 'scopes'>
): Promise<ApiKeyFixture> {
  // Same shape the control plane mints: a UUID id and a 64-character hex secret.
  const id = `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
  const secret = seed.toString(16).padStart(2, '0').repeat(32);
  const credential = `sfk_${id}.${secret}`;

  return {
    id,
    secret,
    hash: await sha256Hex(secret),
    credential,
    authorization: `Bearer ${credential}`,
    record: {
      id,
      ...record,
      createdAt: '2026-04-26T00:00:00.000Z',
      revokedAt: null,
      lastUsedAt: null
    }
  };
}

export const apiKeys = {
  project: await createApiKeyFixture(1, {
    projectSlug: 'demo',
    name: 'Demo key',
    scopes: ['table:create', 'table:read']
  }),
  touch: await createApiKeyFixture(2, {
    projectSlug: 'demo',
    name: 'Touch key',
    scopes: ['table:read']
  }),
  projectAdmin: await createApiKeyFixture(3, {
    projectSlug: 'demo',
    name: 'Demo admin key',
    scopes: ['admin:projects', 'admin:keys', 'table:read']
  }),
  global: await createApiKeyFixture(4, {
    projectSlug: null,
    name: 'Global key',
    scopes: ['admin:keys']
  }),
  globalAdmin: await createApiKeyFixture(5, {
    projectSlug: null,
    name: 'Global admin key',
    scopes: ['admin:projects', 'admin:keys']
  }),
  writeOnly: await createApiKeyFixture(6, {
    projectSlug: 'demo',
    name: 'Write-only key',
    scopes: ['table:create']
  }),
  otherProject: await createApiKeyFixture(7, {
    projectSlug: 'other',
    name: 'Other project key',
    scopes: ['table:read']
  })
} satisfies Record<string, ApiKeyFixture>;

export const apiKeyFixtures: readonly ApiKeyFixture[] = Object.values(apiKeys);

/** A well-formed credential whose id was never minted. */
export const forgedApiKey = await createApiKeyFixture(255, {
  projectSlug: null,
  name: 'Forged key',
  scopes: ['admin:projects']
});

/** A well-formed credential that reuses a real key id with the wrong secret. */
export function withWrongSecret(fixture: ApiKeyFixture) {
  return `sfk_${fixture.id}.${'0'.repeat(64)}`;
}
