import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminListApiKeysResultSchema,
  deleteProjectResultSchema,
  listRowsResultSchema
} from '@sheetflare/contracts';
import { expectRpcResult } from '../../../packages/cloudflare/test/support/rpc-result';
import { sha256Hex } from './support/api-keys';
import { readJsonLogs } from './support/logs';
import { createRealStack, readError, readJson, type MintedKey, type RealStack } from './support/real-stack';

// Auth through the whole stack: the real gateway in front of the real ControlPlaneDO, ProjectDO, TableDO and
// RateLimitDO, with only Google faked at the fetch boundary. See support/real-stack.ts.
//
// Each test names the check it pins. Removing that check from the gateway or from a Durable Object makes the test
// fail, which is what the canned-namespace tests in index.test.ts and auth.test.ts cannot show.

const startedAt = Date.parse('2026-10-29T12:00:00.000Z');
// Matches `principalCacheTtlMs` in the gateway: the documented lifetime of a verified key on an isolate.
const principalCacheLifetimeMs = 10_000;

const usersRows = [['_id', 'name'], ['u1', 'Ada'], ['u2', 'Grace']];
const ordersRows = [['_id', 'sku'], ['o1', 'sku-100']];
const usersPath = '/v1/projects/demo/tables/users/rows';
const ordersPath = '/v1/projects/other/tables/orders/rows';

// The gateway logs and swallows these instead of failing the request. In a stack where every Durable Object is real
// and Google answers every call the scenarios make, none of them should ever happen, so a test fails if one does.
const swallowedFailureEvents: readonly string[] = [
  'api_key.touch.failed',
  'cache.invalidation.failed',
  'cached_table_read.error',
  'durable_object.error',
  'google.request.failed'
];

let stack: RealStack;
let swallowedFailures: () => unknown[];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  swallowedFailures = () =>
    [...readJsonLogs(warnSpy), ...readJsonLogs(errorSpy)].filter(
      ({ event }) => typeof event === 'string' && swallowedFailureEvents.includes(event)
    );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startedAt);
  stack = createRealStack();
});

afterEach(() => {
  const swallowed = swallowedFailures();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(swallowed).toEqual([]);
});

async function readCells(response: Response, field: string) {
  const { data } = await readJson(response, listRowsResultSchema);
  return data.map((row) => row.values[field]);
}

function countKeys() {
  return stack.controlPlane.sql('SELECT COUNT(*) AS count FROM api_keys');
}

describe('API key lifecycle', () => {
  beforeEach(async () => {
    await stack.provision({ slug: 'demo', rows: usersRows });
  });

  // Pins: the hash comparison in ControlPlaneDO.verifyApiKey, what the gateway hashes, the revoked check in
  // verifyApiKey, the revoke update, and the gateway forgetting a key on the isolate that revokes it.
  it('creates a scoped key, authenticates it, rejects a wrong secret, and stops accepting it once revoked', async () => {
    const created = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    expect(created.record).toMatchObject({
      id: created.id,
      projectSlug: 'demo',
      scopes: ['table:read'],
      revokedAt: null
    });
    const asKey = stack.requestAs(created.credential);

    // The key opens the route its scope permits, and the rows come from the sheet through the real table object.
    const allowed = await asKey(usersPath);
    expect(allowed.status).toBe(200);
    expect(await readCells(allowed, 'name')).toEqual(['Ada', 'Grace']);

    // The same key id with another secret is rejected, even while the real key is verified and cached on this isolate.
    const wrongSecret = await stack.requestAs(`sfk_${created.id}.${'0'.repeat(64)}`)(usersPath);
    expect(wrongSecret.status).toBe(401);
    expect(await readError(wrongSecret)).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid API key.' });
    expect((await asKey(usersPath)).status).toBe(200);

    // Revoking over the admin API takes effect on the very next request: this isolate forgets the key at once, ...
    const revoked = await stack.requestAs(stack.bootstrapToken)(`/v1/admin/keys/${created.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect((await asKey(usersPath)).status).toBe(401);

    // ... and the control plane recorded it, so an isolate that never saw the key refuses it too.
    stack.freshIsolate();
    expect((await asKey(usersPath)).status).toBe(401);

    // The revoked key stays in the audit list, marked as revoked.
    const listed = await readJson(
      await stack.requestAs(stack.bootstrapToken)('/v1/admin/keys?project=demo'),
      adminListApiKeysResultSchema
    );
    expect(listed.data).toEqual([expect.objectContaining({ id: created.id, revokedAt: expect.any(String) })]);
  });

  // Pins: the isolate cache lifetime (principalCacheTtlMs) and that the control plane, not the cache, is the truth.
  it('keeps accepting a revoked key on an isolate that verified it earlier, but only for the cache lifetime', async () => {
    const created = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    const asKey = stack.requestAs(created.credential);

    expect((await asKey(usersPath)).status).toBe(200);
    expect(stack.rpcsOf('control.api-key.verify')).toHaveLength(1);

    // Another isolate handled the revoke request, so this isolate is never told: only the control plane knows.
    const revoked = await stack.controlPlane.rpc({
      type: 'control.api-key.revoke',
      apiKeyId: created.id,
      revokedAt: new Date().toISOString()
    });
    expect(revoked).toEqual({ type: 'control.api-key.revoke.result', result: { ok: true } });

    // Documented lag: the isolate vouches for the key from memory until its entry expires, without asking again.
    vi.setSystemTime(startedAt + principalCacheLifetimeMs - 1_000);
    expect((await asKey(usersPath)).status).toBe(200);
    expect(stack.rpcsOf('control.api-key.verify')).toHaveLength(1);

    // Once the entry has expired the isolate asks the control plane again and gets the revocation.
    vi.setSystemTime(startedAt + principalCacheLifetimeMs + 100);
    expect((await asKey(usersPath)).status).toBe(401);
    expect(stack.rpcsOf('control.api-key.verify')).toHaveLength(2);
  });
});

describe('gateway and control plane agree on the key hash', () => {
  // Pins: what the gateway hashes, what ControlPlaneDO.createApiKey stores, and the hash comparison in verifyApiKey.
  it('stores the SHA-256 of the secret and is sent exactly that hash by the gateway', async () => {
    await stack.provision({ slug: 'demo', rows: usersRows });
    const key = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    const secretHash = await sha256Hex(key.secret);

    // Stored: a digest of the secret alone, computed here independently of the gateway and the control plane.
    expect(stack.controlPlane.sql('SELECT hash FROM api_keys WHERE id = ?', key.id)).toEqual([{ hash: secretHash }]);

    // Sent: a request that reaches the control plane (no cached verification) carries that same digest.
    stack.freshIsolate();
    stack.clearRpcs();
    expect((await stack.requestAs(key.credential)(usersPath)).status).toBe(200);
    expect(stack.rpcsOf('control.api-key.verify').map((record) => record.body)).toEqual([
      { type: 'control.api-key.verify', apiKeyId: key.id, hash: secretHash }
    ]);

    // Compared: the control plane returns the key for that digest and for nothing else a gateway could send.
    const verify = async (hash: string) =>
      expectRpcResult(
        await stack.controlPlane.rpc({ type: 'control.api-key.verify', apiKeyId: key.id, hash }),
        'control.api-key.verify.result'
      ).record;
    expect(await verify(secretHash)).toMatchObject({ id: key.id, projectSlug: 'demo' });
    expect(await verify(key.secret)).toBeNull();
    expect(await verify(await sha256Hex(key.credential))).toBeNull();
    expect(await verify(await sha256Hex(key.id))).toBeNull();
    expect(await verify(await sha256Hex('0'.repeat(64)))).toBeNull();
  });
});

describe('project-scoped keys', () => {
  let demoAdmin: MintedKey;
  let otherReader: MintedKey;
  let globalAdmin: MintedKey;

  beforeEach(async () => {
    await stack.provision({ slug: 'demo', rows: usersRows });
    await stack.provision({ slug: 'other', tableSlug: 'orders', sheetTabName: 'Orders', rows: ordersRows });
    demoAdmin = await stack.mintKey({
      name: 'Demo key admin',
      projectSlug: 'demo',
      scopes: ['table:read', 'admin:keys']
    });
    otherReader = await stack.mintKey({ name: 'Other reader', projectSlug: 'other', scopes: ['table:read'] });
    globalAdmin = await stack.mintKey({ name: 'Global key admin', projectSlug: null, scopes: ['admin:keys'] });
  });

  // Pins: the project boundary on table reads (assertCredentialProjectBoundary).
  it('reads its own project and is refused another, without touching the other project', async () => {
    const asDemo = stack.requestAs(demoAdmin.credential);

    expect(await readCells(await asDemo(usersPath), 'name')).toEqual(['Ada', 'Grace']);

    stack.clearRpcs();
    const refused = await asDemo(ordersPath);
    expect(refused.status).toBe(403);
    expect((await readError(refused)).code).toBe('FORBIDDEN');
    const touched = stack.rpcs
      .filter((record) => record.target === 'project' || record.target === 'table')
      .map((record) => record.name);
    expect(touched).not.toContain('project:other');
    expect(touched).not.toContain('table:other:orders');

    // The refusal is about the key, not the project: its own key reads it.
    expect(await readCells(await stack.requestAs(otherReader.credential)(ordersPath), 'sku')).toEqual(['sku-100']);
  });

  // Pins: the delegation check (assertApiKeyCanDelegateScopes) and the own-project check in the create route.
  it.each([
    { name: 'a scope it does not hold', input: { projectSlug: 'demo', scopes: ['table:read', 'table:delete'] } },
    { name: 'admin:projects, which it does not hold', input: { projectSlug: 'demo', scopes: ['admin:projects'] } },
    { name: 'another project', input: { projectSlug: 'other', scopes: ['table:read'] } },
    { name: 'no project, which would make it a global key', input: { projectSlug: null, scopes: ['table:read'] } }
  ])('refuses to mint a key with $name', async ({ input }) => {
    const keysBefore = countKeys();

    const refused = await stack.requestAs(demoAdmin.credential)('/v1/admin/keys', {
      method: 'POST',
      json: { name: 'Escalated', ...input }
    });

    expect(refused.status).toBe(403);
    expect((await readError(refused)).code).toBe('FORBIDDEN');
    expect(countKeys()).toEqual(keysBefore);
  });

  it('mints a narrower key for its own project, which then works there and nowhere else', async () => {
    const narrower = await stack.mintKey(
      { name: 'Narrower', projectSlug: 'demo', scopes: ['table:read'] },
      demoAdmin.credential
    );
    const asNarrower = stack.requestAs(narrower.credential);

    expect((await asNarrower(usersPath)).status).toBe(200);
    expect((await asNarrower(ordersPath)).status).toBe(403);
  });

  // Pins: the project check in the revoke route.
  it.each([
    { name: "another project's key", victim: () => otherReader, probe: ordersPath },
    { name: 'a global key', victim: () => globalAdmin, probe: '/v1/admin/keys' }
  ])('cannot revoke $name', async ({ victim, probe }) => {
    const target = victim();

    const refused = await stack.requestAs(demoAdmin.credential)(`/v1/admin/keys/${target.id}`, { method: 'DELETE' });

    expect(refused.status).toBe(403);
    expect((await readError(refused)).code).toBe('FORBIDDEN');
    // Revocation was refused for real, not only hidden by a cache: an isolate that asks the control plane still
    // sees the key as valid.
    stack.freshIsolate();
    expect((await stack.requestAs(target.credential)(probe)).status).toBe(200);
  });

  it('revokes a key of its own project', async () => {
    const narrower = await stack.mintKey(
      { name: 'Narrower', projectSlug: 'demo', scopes: ['table:read'] },
      demoAdmin.credential
    );

    const revoked = await stack.requestAs(demoAdmin.credential)(`/v1/admin/keys/${narrower.id}`, { method: 'DELETE' });

    expect(revoked.status).toBe(200);
    expect((await stack.requestAs(narrower.credential)(usersPath)).status).toBe(401);
  });

  // Pins: the project filter on the key list.
  it('lists only the keys of its own project and is refused the list of another', async () => {
    const asDemo = stack.requestAs(demoAdmin.credential);

    const own = await readJson(await asDemo('/v1/admin/keys'), adminListApiKeysResultSchema);
    expect(own.data.map((key) => key.id)).toEqual([demoAdmin.id]);

    expect((await asDemo('/v1/admin/keys?project=other')).status).toBe(403);
  });
});

describe('project deletion', () => {
  const rebornRows = [['_id', 'name'], ['r1', 'Reborn']];

  async function deleteDemo() {
    const response = await stack.requestAs(stack.bootstrapToken)('/v1/admin/projects/demo', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await readJson(response, deleteProjectResultSchema)).toEqual({
      ok: true,
      deletedProject: 'demo',
      deletedTables: ['users']
    });
  }

  // The slug is reused for a different spreadsheet, like a team recycling the name `demo`.
  async function recreateDemo() {
    await stack.provision({ slug: 'demo', spreadsheetId: 'sheet-demo-reborn', rows: rebornRows });
  }

  beforeEach(async () => {
    await stack.provision({ slug: 'demo', rows: usersRows });
    await stack.provision({ slug: 'other', tableSlug: 'orders', sheetTabName: 'Orders', rows: ordersRows });
  });

  // Pins: the key revocation in ControlPlaneDO.deleteProjectSummary, and that it only touches the deleted slug.
  it("revokes the project's keys, leaves other projects' keys alone, and does not let a re-created slug inherit them", async () => {
    const reader = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    const projectAdmin = await stack.mintKey({
      name: 'Demo admin',
      projectSlug: 'demo',
      scopes: ['admin:projects', 'admin:keys']
    });
    const otherReader = await stack.mintKey({ name: 'Other reader', projectSlug: 'other', scopes: ['table:read'] });
    expect((await stack.requestAs(reader.credential)(usersPath)).status).toBe(200);
    expect((await stack.requestAs(projectAdmin.credential)('/v1/admin/projects?project=demo')).status).toBe(200);

    await deleteDemo();

    // Later requests land on isolates that have not seen these keys, so only the control plane's answer counts.
    stack.freshIsolate();
    expect((await stack.requestAs(reader.credential)(usersPath)).status).toBe(401);
    expect((await stack.requestAs(projectAdmin.credential)('/v1/admin/projects?project=demo')).status).toBe(401);
    expect((await stack.requestAs(otherReader.credential)(ordersPath)).status).toBe(200);

    await recreateDemo();
    const reborn = await stack.mintKey({ name: 'Reborn reader', projectSlug: 'demo', scopes: ['table:read'] });

    stack.freshIsolate();
    expect((await stack.requestAs(reader.credential)(usersPath)).status).toBe(401);
    expect((await stack.requestAs(projectAdmin.credential)('/v1/admin/projects?project=demo')).status).toBe(401);
    expect(await readCells(await stack.requestAs(reborn.credential)(usersPath), 'name')).toEqual(['Reborn']);
  });

  // Pins: `revokeApiKeys` on project creation, which closes the hole for keys a deletion did not revoke.
  it('revokes keys that an earlier release left behind when the slug is created again', async () => {
    const leftBehind = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    await deleteDemo();
    // Releases before project deletion revoked keys left them live, so put this one back into that state.
    stack.controlPlane.sql('UPDATE api_keys SET revoked_at = NULL WHERE id = ?', leftBehind.id);
    const stillLive = expectRpcResult(
      await stack.controlPlane.rpc({ type: 'control.api-key.get', apiKeyId: leftBehind.id }),
      'control.api-key.get.result'
    ).record;
    expect(stillLive?.revokedAt).toBeNull();

    await recreateDemo();

    stack.freshIsolate();
    expect((await stack.requestAs(leftBehind.credential)(usersPath)).status).toBe(401);
  });

  // KNOWN BUG, reported and not fixed here (apps/api/src/index.ts is owned by another change): deleting a project
  // revokes its keys at the control plane, but the isolate that handled the delete keeps vouching for them from its
  // verified-principal cache for up to ten seconds, and only DELETE /v1/admin/keys/:id evicts a key. A slug that is
  // re-created inside that window therefore serves its new data to the deleted project's key. The two tests above
  // pass because they start from a fresh isolate. Drop `.fails` once the delete route evicts the project's keys.
  it.fails('rejects a deleted project key at once on the isolate that deleted it, even after the slug is re-created', async () => {
    const reader = await stack.mintKey({ name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] });
    expect((await stack.requestAs(reader.credential)(usersPath)).status).toBe(200);

    await deleteDemo();
    await recreateDemo();

    expect((await stack.requestAs(reader.credential)(usersPath)).status).toBe(401);
  });
});

describe('unknown project slugs', () => {
  // Pins: ProjectDO persisting nothing until its first project write. Anonymous callers can address a ProjectDO for
  // any valid slug, so a Durable Object that wrote storage on construction would be minted per guessed slug.
  it('leaves no project storage behind when anonymous callers read slugs that do not exist', async () => {
    const anonymous = stack.requestAs(null);
    const slugs = ['ghost', 'phantom', 'nobody-home'];

    for (const slug of slugs) {
      for (const path of ['rows', 'rows/u1', 'schema']) {
        const response = await anonymous(`/v1/projects/${slug}/tables/users/${path}`);
        expect(response.status).toBe(401);
      }
    }

    // The reads did reach each project's Durable Object, so the empty storage below is not an untouched object.
    const addressed = new Set(stack.rpcs.filter((record) => record.target === 'project').map((record) => record.name));
    expect(addressed).toEqual(new Set(slugs.map((slug) => `project:${slug}`)));
    for (const slug of slugs) {
      expect(stack.projectStorage(slug)).toEqual([]);
    }
    // And they went no further: no table object was addressed and nothing was asked of Google.
    expect(stack.rpcs.filter((record) => record.target === 'table')).toEqual([]);
    expect(stack.google.requests).toEqual([]);

    // Control: a project that exists does persist its tables, so an empty list means nothing was written.
    await stack.provision({ slug: 'demo', rows: usersRows });
    expect(stack.projectStorage('demo')).toEqual(expect.arrayContaining(['project', 'tables']));
  });
});
