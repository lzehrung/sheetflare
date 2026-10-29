import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlPlaneDoRequestSchema, type SpreadsheetWatchNotifyResult } from '@sheetflare/contracts';
import type { Env } from '../src/env';
import { __resetGatewayStateForTests, createApp } from '../src/index';
import { createEnv, probesOf, type FakeDurableObjectHook } from './support/harness';
import { readJsonLogs } from './support/logs';
import { WorkersCacheEmulator } from './support/workers-cache';

const drivePath = '/v1/system/google/drive/notifications';
const adminHeaders = { authorization: 'Bearer secret', 'content-type': 'application/json' };

function notificationRequest(messageNumber: number): RequestInit {
  return {
    method: 'POST',
    headers: {
      'x-goog-channel-id': 'channel-1',
      'x-goog-resource-id': 'resource-1',
      'x-goog-resource-state': 'update',
      'x-goog-message-number': String(messageNumber),
      'x-goog-channel-token': 'drive-secret'
    }
  };
}

function notifyResultResponse(result: Partial<SpreadsheetWatchNotifyResult>) {
  return Response.json({
    type: 'control.spreadsheet-watch.notify.result',
    result: {
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-26T00:00:30.000Z',
      changed: true,
      projectSlugs: ['demo'],
      ...result
    }
  });
}

/**
 * Answers notifications like ControlPlaneDO.recordSpreadsheetNotification: only a message number above every earlier
 * one is a new content change, while replays and out-of-order deliveries are accepted but change nothing. Its registry
 * lists the same projects, all on the notified spreadsheet, so a gateway that scans the registry sees them too.
 */
function createNotifyHook(projectSlugs: string[]): FakeDurableObjectHook {
  let highestMessageNumber = 1;
  return ({ body }) => {
    const request = controlPlaneDoRequestSchema.parse(body);
    if (request.type === 'control.projects.list') {
      return Response.json({
        type: 'control.projects.list.result',
        result: {
          data: projectSlugs.map((slug) => ({
            slug,
            name: slug,
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            tableCount: 1,
            updatedAt: '2026-04-26T00:00:00.000Z'
          }))
        }
      });
    }
    if (request.type !== 'control.spreadsheet-watch.notify') {
      return undefined;
    }

    const messageNumber = Number(request.messageNumber);
    const changed = messageNumber > highestMessageNumber;
    highestMessageNumber = Math.max(highestMessageNumber, messageNumber);
    return notifyResultResponse({ changed, projectSlugs });
  };
}

function controlPlaneRequestTypes(env: Env) {
  return probesOf(env).controlPlaneRequests.map((request) => request.type);
}

/** An ExecutionContext that keeps what the Worker hands to waitUntil, so a test can finish it on purpose. */
function createExecutionContext() {
  const background: Array<Promise<unknown>> = [];
  return {
    executionCtx: {
      waitUntil(promise: Promise<unknown>) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {}
    },
    background,
    async settled() {
      await Promise.all(background);
    }
  };
}

beforeEach(() => {
  __resetGatewayStateForTests();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Drive notifications and the edge cache', () => {
  it('purges every project on the notified spreadsheet with one purge request', async () => {
    const cache = new WorkersCacheEmulator();
    const env = createEnv({
      workersCache: cache,
      hooks: { controlPlane: createNotifyHook(['alpha', 'beta', 'gamma']) }
    });

    const response = await createApp().request(drivePath, notificationRequest(2), env);

    expect(response.status).toBe(204);
    expect(cache.purgeRequests).toEqual([
      expect.objectContaining({ tags: ['project:alpha', 'project:beta', 'project:gamma'], accepted: true })
    ]);
  });

  it('issues no purge for replayed or out-of-order notifications', async () => {
    const cache = new WorkersCacheEmulator();
    const env = createEnv({
      workersCache: cache,
      hooks: { controlPlane: createNotifyHook(['alpha', 'beta', 'gamma']) }
    });
    const app = createApp();

    const statuses = [];
    for (const messageNumber of [2, 3, 3, 2]) {
      statuses.push((await app.request(drivePath, notificationRequest(messageNumber), env)).status);
    }

    expect(statuses).toEqual([204, 204, 204, 204]);
    expect(cache.purgeRequests).toHaveLength(2);
  });

  it('does not purge when the notification recorded no change', async () => {
    const cache = new WorkersCacheEmulator();
    const env = createEnv({
      workersCache: cache,
      hooks: { controlPlane: () => notifyResultResponse({ changed: false, projectSlugs: ['demo'] }) }
    });

    const response = await createApp().request(drivePath, notificationRequest(2), env);

    expect(response.status).toBe(204);
    expect(cache.purgeRequests).toEqual([]);
  });

  it('does not purge when no project is registered on the spreadsheet', async () => {
    const cache = new WorkersCacheEmulator();
    const env = createEnv({
      workersCache: cache,
      hooks: { controlPlane: () => notifyResultResponse({ changed: true, projectSlugs: [] }) }
    });

    const response = await createApp().request(drivePath, notificationRequest(2), env);

    expect(response.status).toBe(204);
    expect(cache.purgeRequests).toEqual([]);
  });

  it('takes the projects to purge from the notify result instead of scanning the registry', async () => {
    const env = createEnv({ hooks: { controlPlane: createNotifyHook(['alpha', 'beta']) } });

    await createApp().request(drivePath, notificationRequest(2), env);

    expect(controlPlaneRequestTypes(env)).toEqual(['control.spreadsheet-watch.notify']);
  });

  it('splits a notification that needs more than 100 tags into purge requests of at most 100', async () => {
    const cache = new WorkersCacheEmulator();
    const projectSlugs = Array.from({ length: 250 }, (_, index) => `project-${index}`);
    const env = createEnv({ workersCache: cache, hooks: { controlPlane: createNotifyHook(projectSlugs) } });

    const response = await createApp().request(drivePath, notificationRequest(2), env);

    expect(response.status).toBe(204);
    expect(cache.purgeRequests.map((request) => request.tags.length)).toEqual([100, 100, 50]);
    expect(cache.purgeRequests.every((request) => request.accepted)).toBe(true);
    expect(cache.purgeRequests.flatMap((request) => request.tags)).toEqual(projectSlugs.map((slug) => `project:${slug}`));
  });

  it('rejects a notify result that breaks the contract without purging', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new WorkersCacheEmulator();
    const env = createEnv({
      workersCache: cache,
      hooks: {
        controlPlane: () => Response.json({
          type: 'control.spreadsheet-watch.notify.result',
          result: { accepted: true, spreadsheetId: 'sheet-1', debounceUntil: null }
        })
      }
    });

    const response = await createApp().request(drivePath, notificationRequest(2), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unexpected control plane spreadsheet watch notify response.',
        details: null
      }
    });
    expect(cache.purgeRequests).toEqual([]);
  });
});

describe('purging is best-effort cleanup', () => {
  const updateRequest: RequestInit = {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ values: { name: 'Grace' } })
  };
  const updatePath = '/v1/projects/demo/tables/users/rows/row-1';

  it('sends the table and row tags of an update in one purge request', async () => {
    const cache = new WorkersCacheEmulator();

    const response = await createApp().request(updatePath, updateRequest, createEnv({ workersCache: cache }));

    expect(response.status).toBe(200);
    expect(cache.purgeRequests).toEqual([
      expect.objectContaining({ tags: ['table:demo:users', 'row:demo:users:row-1'], accepted: true })
    ]);
  });

  it('keeps a committed write successful when the purge API rejects the request, and says so only in the log', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = new WorkersCacheEmulator({ purgeBurst: 0 });

    const response = await createApp().request(updatePath, updateRequest, createEnv({ workersCache: cache }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { id: 'row-1', rowNumber: 2, values: { name: 'Grace' } },
      ignoredKeys: []
    });
    expect(response.headers.get('x-sheetflare-cache-invalidation')).toBeNull();
    expect(cache.purgeRequests).toEqual([expect.objectContaining({ accepted: false })]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(readJsonLogs(warnSpy)).toEqual([
      {
        event: 'cache.invalidation.failed',
        method: 'PATCH',
        path: updatePath,
        requestId: response.headers.get('x-request-id'),
        errorName: 'Error',
        errorMessage: 'Workers Cache purge was unsuccessful: 429: Purge rate limit exceeded.'
      }
    ]);
  });

  it('keeps a committed write successful when the purge call itself throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await createApp().request(updatePath, updateRequest, createEnv({ cachedReadPurgeShouldFail: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-sheetflare-cache-invalidation')).toBeNull();
    expect(readJsonLogs(warnSpy)).toEqual([
      expect.objectContaining({ event: 'cache.invalidation.failed', errorMessage: 'Workers Cache purge failed for test.' })
    ]);
  });

  it('does not hold the response for the purge and finishes it through waitUntil', { timeout: 2000 }, async () => {
    const cache = new WorkersCacheEmulator();
    const responseSent = Promise.withResolvers<void>();
    const purge = cache.purge.bind(cache);
    vi.spyOn(cache, 'purge').mockImplementation(async (options) => {
      // The purge may only finish after the client has its response, so a gateway that awaits it deadlocks here.
      await responseSent.promise;
      return purge(options);
    });
    const context = createExecutionContext();

    const response = await createApp().request(updatePath, updateRequest, createEnv({ workersCache: cache }), context.executionCtx);
    expect(response.status).toBe(200);
    expect(cache.purgeRequests).toEqual([]);
    responseSent.resolve();
    await context.settled();

    expect(context.background).toHaveLength(1);
    expect(cache.purgeRequests).toEqual([expect.objectContaining({ accepted: true })]);
  });

  it('logs a purge that fails after the response was sent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = createExecutionContext();

    const response = await createApp().request(
      updatePath,
      updateRequest,
      createEnv({ cachedReadPurgeShouldFail: true }),
      context.executionCtx
    );
    await context.settled();

    expect(response.status).toBe(200);
    expect(readJsonLogs(warnSpy)).toEqual([expect.objectContaining({ event: 'cache.invalidation.failed' })]);
  });
});
