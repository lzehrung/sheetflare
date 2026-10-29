import { describe, expect, it, vi } from 'vitest';
import { toErrorResponse } from '@sheetflare/contracts';
import {
  doRpc,
  durableObjectErrorResponse,
  ProjectDO,
  TableDO,
  type CloudflareEnv,
  type DurableRpcStubLike
} from '../src';
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

function stubRpcError(code: string, status: number, details: unknown): DurableRpcStubLike {
  return {
    async fetch() {
      return Response.json({ error: { code, message: `${code} message.`, details } }, { status });
    }
  };
}

async function captureRpcError(stub: DurableRpcStubLike) {
  return doRpc(stub, { type: 'test' }).then(
    () => {
      throw new Error('Expected the RPC to fail.');
    },
    (error: unknown) => error
  );
}

describe('Durable Object RPC boundaries', () => {
  it('preserves the original status for unknown structured RPC error codes without relaying their details', async () => {
    const error = await captureRpcError(stubRpcError('LOCKED', 423, { retryAfterSeconds: 30 }));

    expect(error).toMatchObject({
      name: 'AppError',
      code: 'LOCKED',
      status: 423,
      message: 'LOCKED message.'
    });
    expect(toErrorResponse(error).body.error.details).toBeNull();
  });

  it.each([
    ['BAD_REQUEST', 400],
    ['CONFLICT', 409],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['TOO_MANY_REQUESTS', 429],
    ['UNAUTHORIZED', 401]
  ])('relays details of the documented %s contract error', async (code, status) => {
    const error = await captureRpcError(stubRpcError(code, status, { field: 'name' }));

    expect(toErrorResponse(error)).toEqual({
      status,
      body: { error: { code, message: `${code} message.`, details: { field: 'name' } } }
    });
  });

  it.each([
    ['BAD_GATEWAY', 502],
    ['SERVICE_UNAVAILABLE', 503]
  ])('relays only the contract message of %s upstream failures', async (code, status) => {
    const error = await captureRpcError(stubRpcError(code, status, {
      status: 403,
      message: 'Google Sheets API has not been used in project 123456789012 before.'
    }));

    expect(toErrorResponse(error)).toEqual({
      status,
      body: { error: { code, message: `${code} message.`, details: null } }
    });
  });

  it('reports malformed GOOGLE_CREDENTIALS_JSON as a configuration error without parser text', async () => {
    const env = createEnv();
    env.GOOGLE_CREDENTIALS_JSON = '{"analytics":{"client_email":"analytics@example.com","private_key":MIIEvQIBADANBgkqhkiG9w0B}}';

    const response = await env.PROJECT_DO
      .get(env.PROJECT_DO.idFromName('project:demo'))
      .fetch('https://do.internal/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          type: 'project.create',
          input: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'analytics'
          }
        })
      });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).not.toContain('MIIEvQ');
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'GOOGLE_CREDENTIALS_JSON is not valid JSON.',
        details: null
      }
    });
  });

  it('logs unexpected Durable Object errors before returning the generic boundary response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = durableObjectErrorResponse(new Error('database password leaked'));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error.',
          details: null
        }
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"durable_object.error"'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"errorMessage":"database password leaked"'));
    } finally {
      errorSpy.mockRestore();
    }
  });

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
