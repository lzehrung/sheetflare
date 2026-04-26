import { zValidator } from '@hono/zod-validator';
import {
  adminProjectParamsSchema,
  adminProjectTableParamsSchema,
  adminCreateApiKeyInputSchema,
  apiKeyParamsSchema,
  createProjectInputSchema,
  createRowInputSchema,
  createTableInputSchema,
  listRowsQuerySchema,
  rowParamsSchema,
  toErrorResponse,
  UnauthorizedError,
  updateRowInputSchema,
  type AdminCreateApiKeyResult,
  type AdminGetProjectResult,
  type AdminListApiKeysResult,
  type AdminListProjectsResult,
  type ApiKeyPrincipal,
  type ApiScope,
  type ControlPlaneDoResponse,
  type CreateRowResult,
  type GetRowResult,
  type GetTableCacheStatusResult,
  type GetSchemaResult,
  type ListRowsResult,
  type ProjectDoResponse,
  type ReindexTableResult,
  type TableDoResponse,
  type UpdateRowResult,
  type UpsertTableResult
} from '@sheetflare/contracts';
import { ControlPlaneDO, RateLimitDO, ProjectDO, TableDO, doRpc } from '@sheetflare/cloudflare';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './env';

type AppVariables = {
  requestId: string;
};

type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'bootstrap-admin' }
  | { kind: 'api-key'; record: ApiKeyPrincipal };

function getControlPlaneStub(env: Env) {
  return env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
}

function getProjectStub(env: Env, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getTableStub(env: Env, projectSlug: string, tableSlug: string) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
}

function parseApiKey(value: string) {
  if (!value.startsWith('sfk_')) {
    throw new UnauthorizedError('Invalid API key.');
  }

  const separatorIndex = value.indexOf('.');
  if (separatorIndex === -1) {
    throw new UnauthorizedError('Invalid API key.');
  }

  return {
    apiKeyId: value.slice(4, separatorIndex),
    secret: value.slice(separatorIndex + 1)
  };
}

async function hashApiKeySecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function authenticateRequest(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<AuthContext> {
  const authorization = c.req.header('authorization');
  if (!authorization) {
    return { kind: 'anonymous' };
  }

  if (!authorization.startsWith('Bearer ')) {
    throw new UnauthorizedError('Unsupported authorization scheme.');
  }

  const credential = authorization.slice('Bearer '.length).trim();
  if (!credential) {
    throw new UnauthorizedError();
  }

  if (c.env.ADMIN_BEARER_TOKEN && credential === c.env.ADMIN_BEARER_TOKEN) {
    return { kind: 'bootstrap-admin' };
  }

  const { apiKeyId, secret } = parseApiKey(credential);
  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
    type: 'control.api-key.verify',
    apiKeyId,
    hash: await hashApiKeySecret(secret)
  });

  const record = (response as {
    type: 'control.api-key.verify.result';
    result: { record: ApiKeyPrincipal | null };
  }).result.record;

  if (!record) {
    throw new UnauthorizedError('Invalid API key.');
  }

  await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
    type: 'control.api-key.touch',
    apiKeyId: record.id,
    usedAt: new Date().toISOString()
  });

  return {
    kind: 'api-key',
    record
  };
}

function hasScope(record: ApiKeyPrincipal, scope: ApiScope) {
  return record.scopes.includes(scope);
}

function assertAdminScope(auth: AuthContext, scope: ApiScope) {
  if (auth.kind === 'bootstrap-admin') {
    return;
  }

  if (auth.kind !== 'api-key' || !hasScope(auth.record, scope)) {
    throw new UnauthorizedError();
  }
}

function assertProjectScope(auth: AuthContext, scope: ApiScope, projectSlug: string) {
  if (auth.kind === 'bootstrap-admin') {
    return;
  }

  if (auth.kind !== 'api-key') {
    throw new UnauthorizedError();
  }

  if (!hasScope(auth.record, scope)) {
    throw new UnauthorizedError();
  }

  if (auth.record.projectSlug && auth.record.projectSlug !== projectSlug) {
    throw new UnauthorizedError();
  }
}

async function loadProject(c: Context<{ Bindings: Env; Variables: AppVariables }>, projectSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.get',
    projectSlug
  });

  return (response as { type: 'project.get.result'; result: AdminGetProjectResult }).result;
}

function parseListRowsQuery(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const query = {
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    cursor: c.req.query('cursor') ?? undefined,
    sort: c.req.query('sort') ?? undefined,
    fields: c.req.query('fields')?.split(',').map((field) => field.trim()).filter(Boolean),
    filter: undefined
  };

  return listRowsQuerySchema.parse(query);
}

function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    c.set('requestId', crypto.randomUUID());

    await next();

    console.info(
      JSON.stringify({
        event: 'request.complete',
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        requestId: c.get('requestId')
      })
    );
  });

  app.onError((error, c) => {
    const { status, body } = toErrorResponse(error);
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json'
      }
    });
  });

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'sheetflare-api'
    })
  );

  app.get('/v1/admin/projects', async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:projects');
    const project = c.req.query('project');

    if (project) {
      return c.json(await loadProject(c, project));
    }

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.projects.list'
    });

    return c.json(
      (response as { type: 'control.projects.list.result'; result: AdminListProjectsResult }).result
    );
  });

  app.post('/v1/admin/projects', zValidator('json', createProjectInputSchema), async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:projects');
    const input = c.req.valid('json');
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, input.slug), {
      type: 'project.create',
      input
    });

    return c.json((response as { type: 'project.create.result'; result: AdminGetProjectResult }).result, 201);
  });

  app.get('/v1/admin/projects/:project/tables', zValidator('param', adminProjectParamsSchema), async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = c.req.valid('param');
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.table.list',
      projectSlug: project
    });

    return c.json(
      (response as { type: 'project.table.list.result'; result: { data: UpsertTableResult['data'][] } }).result
    );
  });

  app.post(
    '/v1/admin/projects/:project/tables',
    zValidator('param', adminProjectParamsSchema),
    zValidator('json', createTableInputSchema),
    async (c) => {
      const auth = await authenticateRequest(c);
      const { project } = c.req.valid('param');
      assertProjectScope(auth, 'admin:projects', project);
      const input = c.req.valid('json');
      const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
        type: 'project.table.create',
        projectSlug: project,
        input
      });

      return c.json(
        (response as { type: 'project.table.create.result'; result: UpsertTableResult }).result,
        201
      );
    }
  );

  app.get(
    '/v1/projects/:project/tables/:table/rows',
    zValidator('param', adminProjectTableParamsSchema),
    async (c) => {
      const { project, table } = c.req.valid('param');
      const auth = await authenticateRequest(c);
      const projectState = await loadProject(c, project);
      if (projectState.project.defaultAuthMode !== 'public-read') {
        assertProjectScope(auth, 'table:read', project);
      }
      const query = parseListRowsQuery(c);
      const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
        type: 'table.rows.list',
        projectSlug: project,
        tableSlug: table,
        query
      });

      return c.json((response as { type: 'table.rows.list.result'; result: ListRowsResult }).result);
    }
  );

  app.get('/v1/projects/:project/tables/:table/schema', zValidator('param', adminProjectTableParamsSchema), async (c) => {
    const { project, table } = c.req.valid('param');
    const auth = await authenticateRequest(c);
    const projectState = await loadProject(c, project);
    if (projectState.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', project);
    }
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.schema.get',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.schema.get.result'; result: GetSchemaResult }).result);
  });

  app.get('/v1/admin/projects/:project/tables/:table/cache', zValidator('param', adminProjectTableParamsSchema), async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = c.req.valid('param');
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.cache.get',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.cache.get.result'; result: GetTableCacheStatusResult }).result);
  });

  app.post('/v1/admin/projects/:project/tables/:table/reindex', zValidator('param', adminProjectTableParamsSchema), async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = c.req.valid('param');
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.reindex',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.reindex.result'; result: ReindexTableResult }).result);
  });

  app.get('/v1/projects/:project/tables/:table/rows/:id', zValidator('param', rowParamsSchema), async (c) => {
    const { project, table, id } = c.req.valid('param');
    const auth = await authenticateRequest(c);
    const projectState = await loadProject(c, project);
    if (projectState.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', project);
    }
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.row.get',
      projectSlug: project,
      tableSlug: table,
      rowId: id
    });

    return c.json((response as { type: 'table.row.get.result'; result: GetRowResult }).result);
  });

  app.post(
    '/v1/projects/:project/tables/:table/rows',
    zValidator('param', adminProjectTableParamsSchema),
    zValidator('json', createRowInputSchema),
    async (c) => {
      const { project, table } = c.req.valid('param');
      const auth = await authenticateRequest(c);
      assertProjectScope(auth, 'table:create', project);
      const input = c.req.valid('json');
      const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
        type: 'table.row.create',
        projectSlug: project,
        tableSlug: table,
        input
      });

      return c.json((response as { type: 'table.row.create.result'; result: CreateRowResult }).result, 201);
    }
  );

  app.patch(
    '/v1/projects/:project/tables/:table/rows/:id',
    zValidator('param', rowParamsSchema),
    zValidator('json', updateRowInputSchema),
    async (c) => {
      const { project, table, id } = c.req.valid('param');
      const auth = await authenticateRequest(c);
      assertProjectScope(auth, 'table:update', project);
      const input = c.req.valid('json');
      const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
        type: 'table.row.update',
        projectSlug: project,
        tableSlug: table,
        rowId: id,
        input
      });

      return c.json((response as { type: 'table.row.update.result'; result: UpdateRowResult }).result);
    }
  );

  app.delete('/v1/projects/:project/tables/:table/rows/:id', zValidator('param', rowParamsSchema), async (c) => {
    const { project, table, id } = c.req.valid('param');
    const auth = await authenticateRequest(c);
    assertProjectScope(auth, 'table:delete', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.row.delete',
      projectSlug: project,
      tableSlug: table,
      rowId: id
    });

    return c.json(
      (response as {
        type: 'table.row.delete.result';
        result: { ok: true; deletedId: string };
      }).result
    );
  });

  app.get('/v1/admin/keys', async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const projectSlug = c.req.query('project') ?? null;

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-keys.list',
      projectSlug
    });

    return c.json(
      (response as { type: 'control.api-keys.list.result'; result: AdminListApiKeysResult }).result
    );
  });

  app.post('/v1/admin/keys', zValidator('json', adminCreateApiKeyInputSchema), async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const input = c.req.valid('json');
    if (input.projectSlug) {
      await loadProject(c, input.projectSlug);
    }

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-key.create',
      input
    });

    return c.json(
      (response as { type: 'control.api-key.create.result'; result: AdminCreateApiKeyResult }).result,
      201
    );
  });

  app.delete('/v1/admin/keys/:id', zValidator('param', apiKeyParamsSchema), async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const { id } = c.req.valid('param');

    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-key.revoke',
      apiKeyId: id,
      revokedAt: new Date().toISOString()
    });

    return c.json({ ok: true });
  });

  return app;
}

const app = createApp();

export { ControlPlaneDO, ProjectDO, TableDO, RateLimitDO, createApp };
export default app;
