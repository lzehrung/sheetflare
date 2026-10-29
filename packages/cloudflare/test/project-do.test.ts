import { describe, expect, it } from 'vitest';
import type { ProjectDoRequest, ProjectDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';

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
