import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ControlPlaneDoResponse, ProjectDoRequest, ProjectDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';
import { expectRpcResult } from './support/rpc-result';

const rpcRequestSchema = z.object({
  type: z.string(),
  projectSlug: z.string().optional(),
  spreadsheetId: z.string().optional()
});
type ControlPlaneCall = z.infer<typeof rpcRequestSchema>;
type ControlPlaneCallMatch = { type: string; projectSlug: string; spreadsheetId?: string };
type HeldControlPlaneCall = { match: ControlPlaneCallMatch; arrived: () => void; released: Promise<void> };

async function settle<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}

function createTestEnv(googlePrivateKey = 'default-private-key') {
  const env = {
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: googlePrivateKey,
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      other: { clientEmail: 'other@example.com', privateKey: 'other-private-key' }
    })
  } as CloudflareEnv;
  const controlPlaneNamespace = createDurableObjectNamespace(env, ControlPlaneDO);
  const projectNamespace = createDurableObjectNamespace(env, ProjectDO);
  const failingControlPlaneRequests = new Set<string>();
  const lostControlPlaneResponses = new Set<string>();
  const heldControlPlaneRequests: HeldControlPlaneCall[] = [];
  const heldControlPlaneResponses: HeldControlPlaneCall[] = [];
  // The control-plane binding fails a request type once when asked to, the way an overloaded or restarting Durable
  // Object answers before it has processed anything. It loses the response to a request type once when asked to, after
  // the control plane applied the request, the way a dropped connection does. It can also hold one project's request
  // before the control plane sees it, or the control plane's response to a request, until the test releases it, which
  // lets other requests run in between. Everything else reaches the real ControlPlaneDO.
  env.CONTROL_PLANE_DO = {
    idFromName: (name: string) => controlPlaneNamespace.idFromName(name),
    get: (id: string) => {
      const stub = controlPlaneNamespace.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          const call = rpcRequestSchema.parse(await request.clone().json());
          if (failingControlPlaneRequests.delete(call.type)) {
            return Response.json({
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Durable Object is overloaded.', details: null }
            }, { status: 503 });
          }

          await waitWhileHeld(heldControlPlaneRequests, call);
          const response = await stub.fetch(request);
          if (lostControlPlaneResponses.delete(call.type)) {
            throw new Error('Network connection lost.');
          }

          await waitWhileHeld(heldControlPlaneResponses, call);
          return response;
        }
      };
    }
  } as never;
  env.PROJECT_DO = projectNamespace as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return {
    env,
    controlPlaneNamespace,
    projectNamespace,
    failNextControlPlaneRequest(type: string) {
      failingControlPlaneRequests.add(type);
    },
    loseNextControlPlaneResponse(type: string) {
      lostControlPlaneResponses.add(type);
    },
    holdControlPlaneRequest(match: ControlPlaneCallMatch) {
      return hold(heldControlPlaneRequests, match);
    },
    holdControlPlaneResponse(type: string, projectSlug: string) {
      return hold(heldControlPlaneResponses, { type, projectSlug });
    }
  };
}

function hold(held: HeldControlPlaneCall[], match: ControlPlaneCallMatch) {
  const arrival = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  held.push({ match, arrived: arrival.resolve, released: release.promise });
  return { arrived: arrival.promise, release: release.resolve };
}

async function waitWhileHeld(held: HeldControlPlaneCall[], call: ControlPlaneCall) {
  const entry = held.find(
    ({ match }) =>
      match.type === call.type
      && match.projectSlug === call.projectSlug
      && (match.spreadsheetId === undefined || match.spreadsheetId === call.spreadsheetId)
  );
  if (entry) {
    held.splice(held.indexOf(entry), 1);
    entry.arrived();
    await entry.released;
  }
}

function getProjectStub(env: CloudflareEnv, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getControlPlaneStub(env: CloudflareEnv) {
  return env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
}

async function hashApiKeySecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function createProjectKey(env: CloudflareEnv, projectSlug: string) {
  const created = expectRpcResult(
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
      type: 'control.api-key.create',
      input: { name: `${projectSlug} admin`, projectSlug, scopes: ['admin:projects', 'table:read'] }
    }),
    'control.api-key.create.result'
  );
  return {
    id: created.record.id,
    hash: await hashApiKeySecret(created.apiKey.split('.')[1] ?? '')
  };
}

async function verifyKey(env: CloudflareEnv, key: { id: string; hash: string }) {
  return expectRpcResult(
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
      type: 'control.api-key.verify',
      apiKeyId: key.id,
      hash: key.hash
    }),
    'control.api-key.verify.result'
  ).record;
}

async function listRegisteredPairings(env: CloudflareEnv) {
  const registry = expectRpcResult(
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), { type: 'control.projects.list' }),
    'control.projects.list.result'
  );
  return registry.data
    .map((project) => `${project.slug}:${project.spreadsheetId}:${project.googleCredentialRef}`)
    .sort();
}

// Lets every request that is not waiting on a held control-plane call run until it finishes or starts waiting.
async function letOtherRequestsRun() {
  for (let turn = 0; turn < 50; turn += 1) {
    const nextTurn = Promise.withResolvers<void>();
    setImmediate(nextTurn.resolve);
    await nextTurn.promise;
  }
}

// A private key the Google client can sign its token request with. Google itself is stubbed, so the key goes nowhere.
async function generateGooglePrivateKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  if (!('privateKey' in keyPair)) {
    throw new Error('Expected a key pair.');
  }

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const base64Lines = btoa(String.fromCharCode(...pkcs8)).match(/.{1,64}/g) ?? [];
  return ['-----BEGIN PRIVATE KEY-----', ...base64Lines, '-----END PRIVATE KEY-----'].join('\n');
}

describe('ProjectDO project lifecycle', () => {
  it('does not let a re-created slug inherit the keys of a project whose delete failed in the control plane', async () => {
    const { env, failNextControlPlaneRequest } = createTestEnv();
    const project = getProjectStub(env, 'tenant-a');
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant-a', name: 'Tenant A', spreadsheetId: 'sheet-1' }
    });
    const oldKey = await createProjectKey(env, 'tenant-a');

    failNextControlPlaneRequest('control.project.delete');
    await expect(doRpc<ProjectDoResponse>(project, { type: 'project.delete', projectSlug: 'tenant-a' }))
      .rejects.toMatchObject({ status: 503 });

    // Nothing was deleted, so the slug cannot be claimed by a new project while the old key still works.
    await expect(doRpc<ProjectDoResponse>(project, { type: 'project.get', projectSlug: 'tenant-a' }))
      .resolves.toMatchObject({ type: 'project.get.result' });
    await expect(doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant-a', name: 'Tenant A again', spreadsheetId: 'sheet-2' }
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    await doRpc<ProjectDoResponse>(project, { type: 'project.delete', projectSlug: 'tenant-a' });
    const recreated = expectRpcResult(
      await doRpc<ProjectDoResponse>(project, {
        type: 'project.create',
        input: { slug: 'tenant-a', name: 'Tenant A again', spreadsheetId: 'sheet-2' }
      }),
      'project.create.result'
    );

    expect(recreated.created).toBe(true);
    expect(await verifyKey(env, oldKey)).toBeNull();
  });

  it('revokes keys still bound to a slug when a new project claims it', async () => {
    const { env } = createTestEnv();
    // A key can outlive its project when it was minted while the project was being deleted or when an earlier release
    // removed the project before revoking its keys.
    const leftoverKey = await createProjectKey(env, 'tenant-b');
    expect(await verifyKey(env, leftoverKey)).not.toBeNull();

    await doRpc<ProjectDoResponse>(getProjectStub(env, 'tenant-b'), {
      type: 'project.create',
      input: { slug: 'tenant-b', name: 'Tenant B', spreadsheetId: 'sheet-1' }
    });

    expect(await verifyKey(env, leftoverKey)).toBeNull();
  });

  it('keeps the keys of an existing project when the project is updated', async () => {
    const { env } = createTestEnv();
    const project = getProjectStub(env, 'tenant-c');
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant-c', name: 'Tenant C', spreadsheetId: 'sheet-1' }
    });
    const key = await createProjectKey(env, 'tenant-c');

    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      allowExisting: true,
      input: { slug: 'tenant-c', name: 'Tenant C renamed', spreadsheetId: 'sheet-2' }
    });

    expect(await verifyKey(env, key)).not.toBeNull();
  });

  it('rejects a project that would share a spreadsheet under another Google credential ref', async () => {
    const { env } = createTestEnv();
    await doRpc<ProjectDoResponse>(getProjectStub(env, 'alpha'), {
      type: 'project.create',
      input: { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' }
    });

    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: {
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'other',
        registeredGoogleCredentialRefs: ['default']
      }
    });
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), { type: 'project.get', projectSlug: 'beta' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    await doRpc<ProjectDoResponse>(getProjectStub(env, 'gamma'), {
      type: 'project.create',
      input: { slug: 'gamma', name: 'Gamma', spreadsheetId: 'sheet-2', googleCredentialRef: 'other' }
    });
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'gamma'), {
      type: 'project.create',
      allowExisting: true,
      input: { slug: 'gamma', name: 'Gamma', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    const registry = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), { type: 'control.projects.list' }),
      'control.projects.list.result'
    );
    expect(registry.data.map((project) => [project.slug, project.spreadsheetId, project.googleCredentialRef])).toEqual(
      expect.arrayContaining([
        ['alpha', 'sheet-1', 'default'],
        ['gamma', 'sheet-2', 'other']
      ])
    );
    expect(registry.data).toHaveLength(2);
  });
});

describe('ProjectDO lifecycle requests that overlap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Two admins create the same slug on different spreadsheets at once. The control plane reaches the second create's
  // reservation only after the first create has registered its project and the project's admin has a key.
  it('does not revoke the keys of a project that another create registered while this create was reserving', async () => {
    const { env, holdControlPlaneRequest } = createTestEnv();
    const project = getProjectStub(env, 'tenant');
    const slowReservation = holdControlPlaneRequest({
      type: 'control.project.reserve',
      projectSlug: 'tenant',
      spreadsheetId: 'sheet-2'
    });
    const first = settle(doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant', name: 'First', spreadsheetId: 'sheet-1' }
    }));
    const second = settle(doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant', name: 'Second', spreadsheetId: 'sheet-2' }
    }));

    expect(await first).toMatchObject({ ok: true, value: { type: 'project.create.result', result: { created: true } } });
    const key = await createProjectKey(env, 'tenant');
    slowReservation.release();

    expect(await second).toMatchObject({ ok: false, error: { code: 'CONFLICT', status: 409 } });
    expect(await verifyKey(env, key)).not.toBeNull();
    // The create that lost holds no claim on its spreadsheet, so another project can use it under another ref.
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'other-tenant'), {
      type: 'project.create',
      input: { slug: 'other-tenant', name: 'Other', spreadsheetId: 'sheet-2', googleCredentialRef: 'other' }
    })).resolves.toMatchObject({ type: 'project.create.result' });
  });

  // The control plane has already dropped the project from its registry, and the delete is waiting for that answer,
  // when a table request for the project arrives. Like every table change it registers the project, whether or not
  // the table exists.
  it('does not let a table request register a project again while the project is being deleted', async () => {
    const { env, holdControlPlaneResponse } = createTestEnv();
    const project = getProjectStub(env, 'tenant');
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant', name: 'Tenant', spreadsheetId: 'sheet-1' }
    });
    const registryAnswer = holdControlPlaneResponse('control.project.delete', 'tenant');
    const deleting = settle(doRpc<ProjectDoResponse>(project, { type: 'project.delete', projectSlug: 'tenant' }));
    await registryAnswer.arrived;
    const deletingTable = settle(doRpc<ProjectDoResponse>(project, {
      type: 'project.table.delete',
      projectSlug: 'tenant',
      tableSlug: 'users'
    }));
    await letOtherRequestsRun();
    registryAnswer.release();

    expect(await deleting).toMatchObject({ ok: true, value: { type: 'project.delete.result' } });
    expect(await deletingTable).toMatchObject({ ok: true, value: { type: 'project.table.delete.result' } });
    expect(await listRegisteredPairings(env)).toEqual([]);
    await expect(doRpc<ProjectDoResponse>(project, { type: 'project.get', projectSlug: 'tenant' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // A table create is checking its tab with Google when a delete of the project arrives, and Google answers last.
  it('does not let a table create that is waiting on Google bring back rows of a project being deleted', async () => {
    const { env, projectNamespace } = createTestEnv(await generateGooglePrivateKey());
    const project = getProjectStub(env, 'tenant');
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'tenant', name: 'Tenant', spreadsheetId: 'sheet-1' }
    });
    const tabsRequested = Promise.withResolvers<void>();
    const tabsAnswered = Promise.withResolvers<void>();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }

      if (url.includes('?fields=sheets.properties')) {
        tabsRequested.resolve();
        await tabsAnswered.promise;
        return Response.json({ sheets: [{ properties: { title: 'Users', sheetId: 1, sheetType: 'GRID' } }] });
      }

      if (url.includes('/values/')) {
        return Response.json({ values: [['_id', 'status']] });
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const creatingTable = settle(doRpc<ProjectDoResponse>(project, {
      type: 'project.table.create',
      projectSlug: 'tenant',
      input: { tableSlug: 'users', sheetTabName: 'Users' }
    }));
    await tabsRequested.promise;
    const deleting = settle(doRpc<ProjectDoResponse>(project, { type: 'project.delete', projectSlug: 'tenant' }));
    await letOtherRequestsRun();
    tabsAnswered.resolve();

    expect(await creatingTable).toMatchObject({ ok: true, value: { type: 'project.table.create.result' } });
    expect(await deleting).toMatchObject({
      ok: true,
      value: { type: 'project.delete.result', result: { deletedTables: ['users'] } }
    });
    expect(projectNamespace.runSql('project:tenant', 'SELECT table_slug FROM tables')).toEqual([]);
    expect(await listRegisteredPairings(env)).toEqual([]);
  });

  it('runs a lifecycle request that waited behind one that failed', async () => {
    const { env, failNextControlPlaneRequest } = createTestEnv();
    const project = getProjectStub(env, 'tenant');
    const create = {
      type: 'project.create',
      input: { slug: 'tenant', name: 'Tenant', spreadsheetId: 'sheet-1' }
    } satisfies ProjectDoRequest;
    failNextControlPlaneRequest('control.project.upsert');
    const first = settle(doRpc<ProjectDoResponse>(project, create));
    const second = settle(doRpc<ProjectDoResponse>(project, create));

    expect(await first).toMatchObject({ ok: false, error: { status: 503 } });
    // The first create took its write back, so the second one finds no project and creates it.
    expect(await second).toMatchObject({ ok: true, value: { type: 'project.create.result', result: { created: true } } });
    expect(await listRegisteredPairings(env)).toEqual(['tenant:sheet-1:default']);
  });
});

describe('ProjectDO spreadsheet reservation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // alpha's create is paused once the control plane has answered its reservation, so alpha has passed the control
  // plane's check but has written and registered nothing while beta creates its project on the same spreadsheet. alpha
  // then continues.
  async function createBetaWhileAlphaIsPreparing(betaInput: { googleCredentialRef?: string }) {
    const { env, projectNamespace, holdControlPlaneResponse } = createTestEnv();
    const alphaPrepared = holdControlPlaneResponse('control.project.reserve', 'alpha');
    const alpha = settle(doRpc<ProjectDoResponse>(getProjectStub(env, 'alpha'), {
      type: 'project.create',
      input: { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' }
    }));
    await alphaPrepared.arrived;
    const beta = await settle(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', ...betaInput }
    }));
    alphaPrepared.release();
    return { env, projectNamespace, alpha: await alpha, beta };
  }

  it('admits only one of two interleaved creations on a spreadsheet under different credential refs', async () => {
    const { env, projectNamespace, alpha, beta } = await createBetaWhileAlphaIsPreparing({
      googleCredentialRef: 'other'
    });

    expect({
      alphaCreated: alpha.ok,
      betaCreated: beta.ok,
      registered: await listRegisteredPairings(env)
    }).toEqual({ alphaCreated: true, betaCreated: false, registered: ['alpha:sheet-1:default'] });
    expect(beta).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        status: 409,
        details: {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'other',
          registeredGoogleCredentialRefs: ['default']
        }
      }
    });
    // The rejected project wrote nothing.
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), { type: 'project.get', projectSlug: 'beta' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(projectNamespace.getStoredTableNames('project:beta')).toEqual([]);
  });

  it('admits both of two interleaved creations on a spreadsheet under the same credential ref', async () => {
    const { env, alpha, beta } = await createBetaWhileAlphaIsPreparing({});

    expect({
      alphaCreated: alpha.ok,
      betaCreated: beta.ok,
      registered: await listRegisteredPairings(env)
    }).toEqual({
      alphaCreated: true,
      betaCreated: true,
      registered: ['alpha:sheet-1:default', 'beta:sheet-1:default']
    });
  });

  // alpha's create reserves the spreadsheet and then fails to write its project. The release that follows can fail too.
  async function createAlphaWhoseWriteFails({ releaseFails = false } = {}) {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, projectNamespace, failNextControlPlaneRequest } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    const input = { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' };
    // A project that was created and deleted leaves the Durable Object with the schema the next create writes to.
    await doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input });
    await doRpc<ProjectDoResponse>(alpha, { type: 'project.delete', projectSlug: 'alpha' });
    projectNamespace.runSql(
      'project:alpha',
      `CREATE TRIGGER reject_project_writes BEFORE INSERT ON project BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
    );
    if (releaseFails) {
      failNextControlPlaneRequest('control.project.release');
    }

    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input }))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('disk I/O error'));
    return { env, projectNamespace, alpha, input, errorSpy };
  }

  it('releases its reservation when the project cannot be written, so another project can use the spreadsheet', async () => {
    const { env } = await createAlphaWhoseWriteFails();

    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    })).resolves.toMatchObject({ type: 'project.create.result' });
    expect(await listRegisteredPairings(env)).toEqual(['beta:sheet-1:other']);
  });

  it('reports the failed write and lets the reservation expire when releasing it fails too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const { env, errorSpy } = await createAlphaWhoseWriteFails({ releaseFails: true });
    const beta = getProjectStub(env, 'beta');
    const betaInput = { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' };

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"project.reservation.release.failed"'));
    await expect(doRpc<ProjectDoResponse>(beta, { type: 'project.create', input: betaInput }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    await expect(doRpc<ProjectDoResponse>(beta, { type: 'project.create', input: betaInput }))
      .resolves.toMatchObject({ type: 'project.create.result' });
  });

  it('lets a create whose write failed be repeated once the write works', async () => {
    const { env, projectNamespace, alpha, input } = await createAlphaWhoseWriteFails();
    projectNamespace.runSql('project:alpha', 'DROP TRIGGER reject_project_writes');

    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input }))
      .resolves.toMatchObject({ type: 'project.create.result', result: { created: true } });
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-1:default']);
  });

  it('keeps the spreadsheet claimed when only registering the project fails, until a repeated create registers it', async () => {
    const { env, failNextControlPlaneRequest } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    const input = { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' };
    failNextControlPlaneRequest('control.project.upsert');
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input }))
      .rejects.toMatchObject({ status: 503 });

    // alpha is written but not registered. Its claim still keeps another project from the spreadsheet under another ref.
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    await doRpc<ProjectDoResponse>(alpha, { type: 'project.create', allowExisting: true, input });
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-1:default']);
  });

  it('takes back a project whose registration failed, so no unregistered project outlives its reservation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const { env, failNextControlPlaneRequest } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    const input = { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' };
    failNextControlPlaneRequest('control.project.upsert');
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input }))
      .rejects.toMatchObject({ status: 503 });

    // Five minutes later the reservation that covered alpha's claim is gone, and another project registers the
    // spreadsheet under another credential ref.
    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    await expect(doRpc<ProjectDoResponse>(getProjectStub(env, 'beta'), {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    })).resolves.toMatchObject({ type: 'project.create.result' });

    // alpha is not left readable under a credential ref its spreadsheet no longer accepts, and repeating its create
    // reports that conflict without writing anything.
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.get', projectSlug: 'alpha' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.create', input }))
      .rejects.toMatchObject({ code: 'CONFLICT', details: { registeredGoogleCredentialRefs: ['other'] } });
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.get', projectSlug: 'alpha' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listRegisteredPairings(env)).toEqual(['beta:sheet-1:other']);
  });

  it('restores an existing project to what is registered when registering its update fails', async () => {
    const { env, failNextControlPlaneRequest } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    const update = {
      type: 'project.create',
      allowExisting: true,
      input: { slug: 'alpha', name: 'Alpha moved', spreadsheetId: 'sheet-2', googleCredentialRef: 'other' }
    } satisfies ProjectDoRequest;
    await doRpc<ProjectDoResponse>(alpha, {
      type: 'project.create',
      input: { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' }
    });

    failNextControlPlaneRequest('control.project.upsert');
    await expect(doRpc<ProjectDoResponse>(alpha, update)).rejects.toMatchObject({ status: 503 });

    const stored = expectRpcResult(
      await doRpc<ProjectDoResponse>(alpha, { type: 'project.get', projectSlug: 'alpha' }),
      'project.get.result'
    );
    expect([stored.project.name, stored.project.spreadsheetId, stored.project.googleCredentialRef])
      .toEqual(['Alpha', 'sheet-1', 'default']);
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-1:default']);

    // The update can be repeated, and then the project and its registration agree again.
    await doRpc<ProjectDoResponse>(alpha, update);
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-2:other']);
  });

  it('unregisters a project whose registration was applied but whose answer was lost', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, loseNextControlPlaneResponse } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    loseNextControlPlaneResponse('control.project.upsert');

    await expect(doRpc<ProjectDoResponse>(alpha, {
      type: 'project.create',
      input: { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' }
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Network connection lost.'));
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.get', projectSlug: 'alpha' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listRegisteredPairings(env)).toEqual([]);
  });

  it('reports a registration it could not take back at the control plane, which deleting the project clears', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, loseNextControlPlaneResponse, failNextControlPlaneRequest } = createTestEnv();
    const alpha = getProjectStub(env, 'alpha');
    loseNextControlPlaneResponse('control.project.upsert');
    failNextControlPlaneRequest('control.project.delete');

    await expect(doRpc<ProjectDoResponse>(alpha, {
      type: 'project.create',
      input: { slug: 'alpha', name: 'Alpha', spreadsheetId: 'sheet-1' }
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });

    // The control plane applied the registration, and the call that unregisters it failed too. alpha is gone from its
    // own storage but still in the registry.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"project.reservation.release.failed"'));
    await expect(doRpc<ProjectDoResponse>(alpha, { type: 'project.get', projectSlug: 'alpha' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-1:default']);

    // Deleting the slug removes what is left of it, as for any project that is already gone.
    await doRpc<ProjectDoResponse>(alpha, { type: 'project.delete', projectSlug: 'alpha' });
    expect(await listRegisteredPairings(env)).toEqual([]);
  });

  it('keeps registering a project whose spreadsheet already has a registry entry under another credential ref', async () => {
    const { env, controlPlaneNamespace } = createTestEnv();
    const beta = getProjectStub(env, 'beta');
    await doRpc<ProjectDoResponse>(beta, {
      type: 'project.create',
      input: { slug: 'beta', name: 'Beta', spreadsheetId: 'sheet-1', googleCredentialRef: 'other' }
    });
    // Registries written before credential refs were checked at creation can hold both refs for one spreadsheet.
    controlPlaneNamespace.runSql(
      'control-plane',
      `INSERT INTO project_registry (slug, name, spreadsheet_id, google_credential_ref, table_count, updated_at)
       VALUES ('alpha', 'Alpha', 'sheet-1', 'default', 0, '2026-05-01T00:00:00.000Z')`
    );

    // A table change registers beta again under the pairing it already has, which is not a new claim.
    await expect(doRpc<ProjectDoResponse>(beta, { type: 'project.table.delete', projectSlug: 'beta', tableSlug: 'users' }))
      .resolves.toMatchObject({ type: 'project.table.delete.result' });
    expect(await listRegisteredPairings(env)).toEqual(['alpha:sheet-1:default', 'beta:sheet-1:other']);
  });
});

describe('ProjectDO storage for unknown projects', () => {
  it('answers reads for an unknown slug with NOT_FOUND without persisting storage', async () => {
    const { env, projectNamespace } = createTestEnv();
    const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:ghost'));
    const reads: ProjectDoRequest[] = [
      { type: 'project.get', projectSlug: 'ghost' },
      { type: 'project.table.list', projectSlug: 'ghost' },
      { type: 'project.table.get', projectSlug: 'ghost', tableSlug: 'users' },
      { type: 'project.table.resolve', projectSlug: 'ghost', tableSlug: 'users' },
      { type: 'project.spreadsheet.tabs.list', projectSlug: 'ghost' },
      { type: 'project.spreadsheet.tab.inspect', projectSlug: 'ghost', tab: 'Users' }
    ];

    for (const read of reads) {
      await expect(doRpc<ProjectDoResponse>(project, read)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404
      });
    }

    expect(projectNamespace.getStoredTableNames('project:ghost')).toEqual([]);
  });
});

describe('ProjectDO table configuration', () => {
  it('serves a table stored with a cache TTL above the contract maximum at the maximum', async () => {
    const { env, projectNamespace } = createTestEnv();
    const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'demo', name: 'Demo', spreadsheetId: 'sheet-1' }
    });
    projectNamespace.runSql(
      'project:demo',
      `INSERT INTO tables (
        project_slug, table_slug, sheet_tab_name, sheet_gid, id_column, indexed_fields, read_only_fields, field_rules,
        header_row, data_start_row, read_enabled, create_enabled, update_enabled, delete_enabled, cache_ttl_seconds,
        created_at, updated_at
      ) VALUES ('demo', 'users', 'Users', NULL, '_id', '["_id"]', '[]', '{}', 1, 2, 1, 1, 1, 1, 86400,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );

    const table = expectRpcResult(
      await doRpc<ProjectDoResponse>(project, { type: 'project.table.get', projectSlug: 'demo', tableSlug: 'users' }),
      'project.table.get.result'
    );
    const resolved = expectRpcResult(
      await doRpc<ProjectDoResponse>(project, { type: 'project.table.resolve', projectSlug: 'demo', tableSlug: 'users' }),
      'project.table.resolve.result'
    );

    expect(table.data.cacheTtlSeconds).toBe(3600);
    expect(resolved.data.resolvedConfig.cacheTtlSeconds).toBe(3600);
  });
});
