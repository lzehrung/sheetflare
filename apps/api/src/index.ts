import { zValidator } from '@hono/zod-validator';
import {
  adminProjectParamsSchema,
  adminProjectTableParamsSchema,
  createProjectInputSchema,
  createRowInputSchema,
  createTableInputSchema,
  listRowsQuerySchema,
  rowParamsSchema,
  toErrorResponse,
  UnauthorizedError,
  updateRowInputSchema,
  type AdminGetProjectResult,
  type AdminListProjectsResult,
  type CreateRowResult,
  type GetRowResult,
  type GetSchemaResult,
  type ListRowsResult,
  type ProjectDoResponse,
  type RegistryDoResponse,
  type ReindexTableResult,
  type TableDoResponse,
  type UpdateRowResult,
  type UpsertTableResult
} from '@sheetflare/contracts';
import { RateLimitDO, RegistryDO, ProjectDO, TableDO, doRpc } from '@sheetflare/cloudflare';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './env';

type AppVariables = {
  requestId: string;
};

function getRegistryStub(env: Env) {
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName('registry'));
}

function getProjectStub(env: Env, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getTableStub(env: Env, projectSlug: string, tableSlug: string) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
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

  app.use('/v1/admin/*', async (c, next) => {
    const adminToken = c.env.ADMIN_BEARER_TOKEN;
    if (!adminToken) {
      await next();
      return;
    }

    const header = c.req.header('authorization');
    if (header !== `Bearer ${adminToken}`) {
      throw new UnauthorizedError();
    }

    await next();
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
    const project = c.req.query('project');

    if (project) {
      const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
        type: 'project.get',
        projectSlug: project
      });

      return c.json((response as { type: 'project.get.result'; result: AdminGetProjectResult }).result);
    }

    const response = await doRpc<RegistryDoResponse>(getRegistryStub(c.env), {
      type: 'registry.projects.list'
    });

    return c.json(
      (response as { type: 'registry.projects.list.result'; result: AdminListProjectsResult }).result
    );
  });

  app.post('/v1/admin/projects', zValidator('json', createProjectInputSchema), async (c) => {
    const input = c.req.valid('json');
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, input.slug), {
      type: 'project.create',
      input
    });

    return c.json((response as { type: 'project.create.result'; result: AdminGetProjectResult }).result, 201);
  });

  app.get('/v1/admin/projects/:project/tables', zValidator('param', adminProjectParamsSchema), async (c) => {
    const { project } = c.req.valid('param');
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
      const { project } = c.req.valid('param');
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
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.schema.get',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.schema.get.result'; result: GetSchemaResult }).result);
  });

  app.post('/v1/admin/projects/:project/tables/:table/reindex', zValidator('param', adminProjectTableParamsSchema), async (c) => {
    const { project, table } = c.req.valid('param');
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.reindex',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.reindex.result'; result: ReindexTableResult }).result);
  });

  app.get('/v1/projects/:project/tables/:table/rows/:id', zValidator('param', rowParamsSchema), async (c) => {
    const { project, table, id } = c.req.valid('param');
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

  return app;
}

const app = createApp();

export { RegistryDO, ProjectDO, TableDO, RateLimitDO, createApp };
export default app;
