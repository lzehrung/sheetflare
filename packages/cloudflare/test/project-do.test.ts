import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ControlPlaneDoResponse, ProjectDoRequest, ProjectDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';
import { expectRpcResult } from './support/rpc-result';

const rpcRequestTypeSchema = z.object({ type: z.string() });

function createTestEnv() {
  const env = {
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: 'default-private-key',
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      other: { clientEmail: 'other@example.com', privateKey: 'other-private-key' }
    })
  } as CloudflareEnv;
  const controlPlaneNamespace = createDurableObjectNamespace(env, ControlPlaneDO);
  const projectNamespace = createDurableObjectNamespace(env, ProjectDO);
  const failingControlPlaneRequests = new Set<string>();
  // The control-plane binding fails a request type once when asked to, the way an overloaded or restarting Durable
  // Object answers; everything else reaches the real ControlPlaneDO.
  env.CONTROL_PLANE_DO = {
    idFromName: (name: string) => controlPlaneNamespace.idFromName(name),
    get: (id: string) => {
      const stub = controlPlaneNamespace.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const request = new Request(input, init);
          const { type } = rpcRequestTypeSchema.parse(await request.clone().json());
          if (failingControlPlaneRequests.delete(type)) {
            return Response.json({
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Durable Object is overloaded.', details: null }
            }, { status: 503 });
          }

          return stub.fetch(request);
        }
      };
    }
  } as never;
  env.PROJECT_DO = projectNamespace as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return {
    env,
    projectNamespace,
    failNextControlPlaneRequest(type: string) {
      failingControlPlaneRequests.add(type);
    }
  };
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
