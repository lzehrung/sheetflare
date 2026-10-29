import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapApiKey } from './bootstrap-config';
import { assertRotationCanHandOffKeys, bootstrapApiKeys } from './bootstrap-keys';

type StoredKey = {
  id: string;
  projectSlug: string | null;
  name: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

const desiredKeys: BootstrapApiKey[] = [
  { name: 'setup-admin', scopes: ['admin:projects', 'admin:keys'] },
  { name: 'setup-read', projectSlug: 'demo', scopes: ['table:read'] },
  { name: 'setup-write', projectSlug: 'demo', scopes: ['table:read', 'table:update'] }
];

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * In-memory stand-in for the three admin key routes (HTTP is the external boundary here).
 * It mirrors ControlPlaneDO semantics: names are not unique, create always inserts,
 * list returns revoked keys too, and DELETE soft-revokes.
 */
class FakeAdminApi {
  keys: StoredKey[] = [];
  requests: string[] = [];
  private counter = 0;
  private server: Server | null = null;

  get activeKeys() {
    return this.keys.filter((key) => key.revokedAt === null);
  }

  seed(name: string) {
    this.counter += 1;
    const key: StoredKey = {
      id: `key${this.counter}`,
      projectSlug: null,
      name,
      scopes: ['table:read'],
      createdAt: new Date(2026, 0, 1, 0, 0, this.counter).toISOString(),
      revokedAt: null,
      lastUsedAt: null
    };
    this.keys.push(key);
    return key;
  }

  async start() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Fake admin API failed to bind a TCP port.');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async stop() {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    this.requests.push(`${method} ${path}`);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (method === 'GET' && path === '/v1/admin/keys') {
      send(200, { data: this.keys });
      return;
    }

    if (method === 'POST' && path === '/v1/admin/keys') {
      const input: { name: string; projectSlug?: string; scopes: string[] } = JSON.parse(await readBody(request));
      const key = this.seed(input.name);
      key.projectSlug = input.projectSlug ?? null;
      key.scopes = input.scopes;
      send(201, { apiKey: `sfk_${key.id}.secret`, record: key });
      return;
    }

    const revokeMatch = /^\/v1\/admin\/keys\/(.+)$/.exec(path);
    if (method === 'DELETE' && revokeMatch) {
      const key = this.keys.find((candidate) => candidate.id === revokeMatch[1]);
      if (key) {
        key.revokedAt = new Date().toISOString();
      }
      send(200, { ok: true });
      return;
    }

    send(404, { error: 'not found' });
  }
}

describe('bootstrapApiKeys', () => {
  const api = new FakeAdminApi();
  let baseUrl = '';

  beforeEach(async () => {
    api.keys = [];
    api.requests = [];
    baseUrl = await api.start();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await api.stop();
  });

  it('creates every configured key on a fresh deployment', async () => {
    const result = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });

    expect(result.created.map((entry) => entry.record.name)).toEqual(['setup-admin', 'setup-read', 'setup-write']);
    expect(result.skipped).toEqual([]);
    expect(result.revoked).toEqual([]);
    expect(api.activeKeys).toHaveLength(3);
  });

  it('does not mint duplicate privileged keys when the same bootstrap is rerun', async () => {
    await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });
    const rerun = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });

    expect(rerun.created).toEqual([]);
    expect(rerun.skipped.map((entry) => entry.name)).toEqual(['setup-admin', 'setup-read', 'setup-write']);
    expect(api.activeKeys).toHaveLength(3);
    expect(api.keys).toHaveLength(3);
    expect(api.requests.filter((entry) => entry.startsWith('POST /v1/admin/keys'))).toHaveLength(3);
  });

  it('only creates the keys that are missing', async () => {
    api.seed('setup-read');

    const result = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });

    expect(result.created.map((entry) => entry.record.name)).toEqual(['setup-admin', 'setup-write']);
    expect(result.skipped.map((entry) => entry.name)).toEqual(['setup-read']);
    expect(api.activeKeys.map((key) => key.name).sort()).toEqual(['setup-admin', 'setup-read', 'setup-write']);
  });

  it('ignores revoked keys with a matching name', async () => {
    const revoked = api.seed('setup-admin');
    revoked.revokedAt = new Date().toISOString();

    const result = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: [desiredKeys[0]!], rotate: false });

    expect(result.created).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('rotates deliberately: issues replacements and revokes every prior active key with the same name', async () => {
    await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });
    const priorIds = api.keys.map((key) => key.id);
    api.seed('setup-admin'); // duplicate left behind by an earlier, unguarded rerun
    const duplicateId = api.keys.at(-1)!.id;

    const result = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: true });

    expect(result.created).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.revoked.map((entry) => entry.id).sort()).toEqual([...priorIds, duplicateId].sort());
    expect(api.activeKeys).toHaveLength(3);
    expect(api.activeKeys.map((key) => key.id)).toEqual(result.created.map((entry) => entry.record.id));
  });

  it('creates all replacements before revoking anything, so rotating the key in use cannot strand later creates', async () => {
    await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: false });
    api.requests = [];

    await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: desiredKeys, rotate: true });

    const methods = api.requests.map((entry) => entry.split(' ')[0]);
    const firstDelete = methods.indexOf('DELETE');
    expect(firstDelete).toBeGreaterThan(-1);
    expect(methods.slice(firstDelete).every((method) => method === 'DELETE')).toBe(true);
  });

  it('makes no requests when no keys are configured', async () => {
    const result = await bootstrapApiKeys({ baseUrl, bearer: 'admin', apiKeys: [], rotate: true });

    expect(result).toEqual({ created: [], skipped: [], revoked: [] });
    expect(api.requests).toEqual([]);
  });
});

describe('assertRotationCanHandOffKeys', () => {
  it('refuses to rotate when the replacement keys would be redacted and nobody captures them', () => {
    expect(() => assertRotationCanHandOffKeys({ rotate: true, showSecrets: false, capturedBySetup: false })).toThrow(
      'SHEETFLARE_SHOW_SECRETS=true'
    );
  });

  it('allows rotation when secrets are shown or setup captures and hands them over', () => {
    expect(() => assertRotationCanHandOffKeys({ rotate: true, showSecrets: true, capturedBySetup: false })).not.toThrow();
    expect(() => assertRotationCanHandOffKeys({ rotate: true, showSecrets: false, capturedBySetup: true })).not.toThrow();
  });

  it('does not constrain runs that are not rotating', () => {
    expect(() => assertRotationCanHandOffKeys({ rotate: false, showSecrets: false, capturedBySetup: false })).not.toThrow();
  });
});
