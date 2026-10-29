import { describe, expect, it } from 'vitest';
import type { ProjectDoRequest, ProjectDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';
import { expectRpcResult } from './support/rpc-result';

function createTestEnv() {
  const env = {
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: 'default-private-key'
  } as CloudflareEnv;
  const projectNamespace = createDurableObjectNamespace(env, ProjectDO);
  env.CONTROL_PLANE_DO = createDurableObjectNamespace(env, ControlPlaneDO) as never;
  env.PROJECT_DO = projectNamespace as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return { env, projectNamespace };
}

describe('ProjectDO storage for unknown projects', () => {
  it('answers reads for an unknown slug with NOT_FOUND without persisting storage', async () => {
    const { env, projectNamespace } = createTestEnv();
    const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:ghost'));
    const reads: ProjectDoRequest[] = [
      { type: 'project.get', projectSlug: 'ghost' },
      { type: 'project.access.get', projectSlug: 'ghost' },
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
