import { describe, expect, it } from 'vitest';
import { ProjectDO, TableDO, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';

function createEnv(): CloudflareEnv {
  const env = {
    CONTROL_PLANE_DO: null as never,
    PROJECT_DO: null as never,
    TABLE_DO: null as never,
    RATE_LIMIT_DO: null as never
  } as CloudflareEnv;
  env.PROJECT_DO = createDurableObjectNamespace(env, ProjectDO) as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  return env;
}

describe('Durable Object RPC boundaries', () => {
  it('serializes ProjectDO contract errors as JSON error responses', async () => {
    const env = createEnv();
    const response = await env.PROJECT_DO
      .get(env.PROJECT_DO.idFromName('project:demo'))
      .fetch('https://do.internal/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          type: 'project.table.get',
          projectSlug: 'demo',
          tableSlug: 'users'
        })
      });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Table demo/users was not found.',
        details: null
      }
    });
  });

  it('rejects malformed JSON at the TableDO RPC boundary', async () => {
    const env = createEnv();
    const response = await env.TABLE_DO
      .get(env.TABLE_DO.idFromName('table:demo:users'))
      .fetch('https://do.internal/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{'
      });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON in Durable Object RPC request.',
        details: null
      }
    });
  });

  it('validates TableDO RPC payloads before runtime dispatch', async () => {
    const env = createEnv();
    const response = await env.TABLE_DO
      .get(env.TABLE_DO.idFromName('table:demo:users'))
      .fetch('https://do.internal/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          type: 'table.rows.list',
          projectSlug: 'demo'
        })
      });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'BAD_REQUEST',
        message: 'Request validation failed.'
      }
    });
  });
});
