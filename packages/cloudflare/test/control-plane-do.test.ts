import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneDoResponse, ProjectDoResponse, TableDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';

const testPrivateKey = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDlvMHyvblYPPUU',
  'A5GgWv+eDKi4Bq1O5fOd+RPKv6hddnX+lk3LSfoPp+I8Nf3uMx56Zh6xV4t30bKI',
  'mHeQVv0QvUieyGHg2vE7QOHD2c7zKJOpPOfF6UWuVg12kUwh2GnI7fXQ5rDiFnzR',
  'bjslEcRo3/6WPaj7R1BpV66pV6Emr40FjYh0t9aiW6zF5Yn38PA2gA3yK2ROfrwQ',
  'iTzADd6T6TcmJ98TGW5jlwmA7hR0lM0JQz2MwQNdAN0DIU1ZwgMz4S3O9GkRDFLO',
  'NPpFJQkNsdPKwhW2oFeWwMgsawFJfSVtJ2A+NxT8ye9VVXAL2h7dV3s3bT8olL8m',
  'CCc5srE1AgMBAAECggEAO5A2MdBB7zYaqR1IxXhQ+QqBZB7ahmRTs7g4D4xMXLvx',
  'vZy0rxIIfXhHV0TGIpSHxgVHaknKfNmaBC1l7N38mAa8eG4W1Q8f4gvX9wVzGO7C',
  'we6lzzrUcdHQnqJIf4ulC0rAI7chMfX2KVbGjL0H6HJc0qnaRbpST7PeE5r8L7yz',
  'j08SwoUnRst0Wp7roJtIUTRILgB1i9lpCCY4QXr75/yP2eC+0/sPO2E8Cq0vvQEj',
  '7fSA9Aj6KgxCDvJ0qH5aig7RlxSljjCLZLmEJ6J0maUfVhD55n4d7ynK+zskolPP',
  'RxykU6Xm6dx9h0x8RNk6SP4ik2XZ7bi16q5DpCrQEQKBgQD9lYq7iR+mh6gL7YLe',
  'ufUbGgeKK9m1o5MMkWFO0QzJe7iJfcr13/Kj6yEofVj0j0ejpqAkCY8M0EdtM+bi',
  'unlV3YUQ2bQdHOuV9ATWGb2V0jNy1lj4Dn+Eq2vxcnocbAqzxeVKvhW+qMlqncKl',
  '6zYqv4M9N2a7cNauMo1bz9BuSQKBgQDow6tfmYIy9a14t17PG6Kk9hoCfABY2U8I',
  'KKo2mCXh3F8A5Qwdlo07n7Yntn/a1/2emH15pkrclDwk93sP4muQzSeY5Egnlh7k',
  '6aHV+yzMncEPDRkTa4Vu+vj4G4j6t+kGV5z5+9UJrLqp92jP/xbc4gYK+2A+nPja',
  '9mYy4wBUmQKBgQDb6vzxaqQzYaoq2CqNJJ5Ft5aNZ2hPsOeonIWQxV6CFSn1soU6',
  'G8A2yyVw+jMwkYIOx8rLqB0SIKtQGtbR2AS6gp2gF0WuaAYQWUfxqT8lvnqMwlRq',
  'hCSdhImWlzlwoNWQX3iA55QONb1fYvU9hSN/Mj1Fd6M2pajVtyjG5xQumQKBgA7K',
  'R6Ps7q34ZuY5d7kSm4L2yv3K7Ir4V5YO0Cw6M8qM2Q1LAuG3heJWbRppqhSiXjFz',
  '1IR6a6FzpxkPk8JKqUu8uYzNslVn4dW9uH3P9Cjlwmj8s3GQd/SCbgnmQ2X1C8iv',
  'rNC4u6d1ScJ8e6BSs4CtLj4C5kkmF6R/V+3lJNUJAoGAIcN6MgzU6k+5jqr6x7Dn',
  'b9Tr2B5Aja0crf6A2z5OZ37tqYI5lcVOS1U8lAGFeZZQmPqQgof59vL2nzLxhg7v',
  'BzUL8C9zH3d7dYQ7fI+R0Wbn6wQ7j38Yz4A0E7XxD7t7t5m3qTDE1pJ2tL7AXmD3',
  'TVa5l7gV7td2D5O9V8mG9tM=',
  '-----END PRIVATE KEY-----'
].join('\n');

type SheetState = {
  rows: string[][];
};

function decodeRangeFromUrl(url: string) {
  const valuesMarker = '/values/';
  const start = url.indexOf(valuesMarker);
  if (start === -1) {
    return null;
  }

  const afterValues = url.slice(start + valuesMarker.length);
  const queryIndex = afterValues.indexOf('?');
  const withoutQuery = queryIndex === -1 ? afterValues : afterValues.slice(0, queryIndex);
  const withoutAppend = withoutQuery.endsWith(':append')
    ? withoutQuery.slice(0, -':append'.length)
    : withoutQuery;
  return decodeURIComponent(withoutAppend);
}

function columnLettersToIndex(columnLetters: string) {
  let result = 0;
  for (const letter of columnLetters) {
    result = result * 26 + (letter.charCodeAt(0) - 64);
  }

  return result - 1;
}

function createSheetsAndDriveFetch(sheet: SheetState) {
  const watchCounts = new Map<string, number>();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('oauth2.googleapis.com/token')) {
      return Response.json({
        access_token: 'token',
        expires_in: 3600
      });
    }

    const watchMatch = url.match(/\/drive\/v3\/files\/([^/]+)\/watch/);
    if (watchMatch) {
      const spreadsheetId = decodeURIComponent(watchMatch[1] ?? '');
      const watchCount = (watchCounts.get(spreadsheetId) ?? 0) + 1;
      watchCounts.set(spreadsheetId, watchCount);
      const channelSuffix = watchCount === 1 ? '' : `-${watchCount}`;
      const expirationValue = init?.body
        ? (JSON.parse(String(init.body)) as { expiration?: string }).expiration ?? null
        : null;
      const expirationMs = expirationValue && /^\d+$/.test(expirationValue)
        ? Number.parseInt(expirationValue, 10)
        : Date.parse(expirationValue ?? '2026-05-01T00:00:00.000Z');
      return Response.json({
        id: `channel-${spreadsheetId}${channelSuffix}`,
        resourceId: `resource-${spreadsheetId}${channelSuffix}`,
        resourceUri: `https://www.googleapis.com/drive/v3/files/${spreadsheetId}`,
        expiration: String(expirationMs)
      });
    }

    if (url.endsWith('/drive/v3/channels/stop')) {
      return Response.json({});
    }

    if (url.includes('?fields=sheets.properties(sheetId,title,sheetType)')) {
      return Response.json({
        sheets: [
          {
            properties: {
              title: 'Users',
              sheetId: 1,
              sheetType: 'GRID'
            }
          }
        ]
      });
    }

    if (url.includes('/values:batchUpdate')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        data?: Array<{ range?: string; values?: string[][] }>;
      };

      for (const update of body.data ?? []) {
        const range = update.range ? decodeURIComponent(update.range) : null;
        const values = update.values?.[0] ?? [];
        if (!range) {
          continue;
        }

        const match = range.match(/^'Users'!([A-Z]+)(\d+):([A-Z]+)\d+$/);
        if (!match) {
          throw new Error(`Unhandled batch value range: ${range}`);
        }

        const startColumnIndex = columnLettersToIndex(match[1]);
        const rowIndex = Number(match[2]) - 1;
        const row = sheet.rows[rowIndex] ?? [];
        for (let index = 0; index < values.length; index += 1) {
          row[startColumnIndex + index] = String(values[index] ?? '');
        }
        sheet.rows[rowIndex] = row;
      }

      return Response.json({});
    }

    const range = decodeRangeFromUrl(url);
    if (!range) {
      throw new Error(`Unexpected request: ${url}`);
    }

    if (init?.method === 'POST' && url.includes(':append')) {
      const body = JSON.parse(String(init.body)) as { values: string[][] };
      const row = sheet.rows.length === 0 ? [] : [...(sheet.rows[sheet.rows.length] ?? [])];
      const appendValues = body.values[0] ?? [];
      const appendRange = range.match(/^'Users'!([A-Z]+)\d+:\1$/);
      if (!appendRange) {
        sheet.rows.push(appendValues);
      } else {
        const columnIndex = columnLettersToIndex(appendRange[1]);
        for (let index = 0; index < appendValues.length; index += 1) {
          row[columnIndex + index] = appendValues[index] ?? '';
        }
        sheet.rows.push(row);
      }
      const rowNumber = sheet.rows.length;
      return Response.json({
        updates: {
          updatedRange: `'Users'!A${rowNumber}:A${rowNumber}`
        }
      });
    }

    if (range === "'Users'") {
      return Response.json({ values: sheet.rows });
    }

    const singleRowMatch = range.match(/^'Users'!(\d+):(\d+)$/);
    if (singleRowMatch) {
      const start = Number(singleRowMatch[1]) - 1;
      const end = Number(singleRowMatch[2]);
      return Response.json({
        values: sheet.rows.slice(start, end)
      });
    }

    const singleColumnMatch = range.match(/^'Users'!([A-Z]+)(\d+):\1$/);
    if (singleColumnMatch) {
      const columnIndex = columnLettersToIndex(singleColumnMatch[1]);
      const startRow = Number(singleColumnMatch[2]) - 1;
      return Response.json({
        values: sheet.rows
          .slice(startRow)
          .map((row) => [row[columnIndex] ?? ''])
      });
    }

    const boundedTableMatch = range.match(/^'Users'!A(\d+):([A-Z]+)$/);
    if (boundedTableMatch) {
      const startRow = Number(boundedTableMatch[1]) - 1;
      const endColumnIndex = columnLettersToIndex(boundedTableMatch[2]);
      return Response.json({
        values: sheet.rows
          .slice(startRow)
          .map((row) => row.slice(0, endColumnIndex + 1))
      });
    }

    throw new Error(`Unhandled sheet range: ${range}`);
  };
}

function createTestEnv(overrides?: Partial<CloudflareEnv>) {
  const partialEnv: Partial<CloudflareEnv> = {
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: testPrivateKey,
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({}),
    GOOGLE_DRIVE_WEBHOOK_SECRET: 'secret-token',
    ...overrides
  };

  const env = partialEnv as CloudflareEnv;
  const controlPlaneNamespace = createDurableObjectNamespace(env, ControlPlaneDO);
  env.CONTROL_PLANE_DO = controlPlaneNamespace as never;
  env.PROJECT_DO = createDurableObjectNamespace(env, ProjectDO) as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return { env, controlPlaneNamespace };
}

describe('ControlPlaneDO Drive watch orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('registers spreadsheet Drive watches from the project registry with stable credential refs', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env } = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    const response = await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30,
        expirationMs: Date.parse('2026-05-01T00:00:00.000Z')
      }
    );

    expect((response as {
      type: 'control.spreadsheet-watches.register.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          googleCredentialRef: string;
          channelId: string;
          resourceId: string;
          debounceUntil: string | null;
          projectSlugs: string[];
        }>;
      };
    }).result.data).toEqual([
      {
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'default',
        channelId: 'channel-sheet-1',
        resourceId: 'resource-sheet-1',
        resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
        expirationAt: '2026-05-01T00:00:00.000Z',
        lastWatchError: null,
        lastNotificationAt: null,
        pendingChangedAt: null,
        debounceUntil: null,
        lastReindexStartedAt: null,
        lastReindexCompletedAt: null,
        lastReindexError: null,
        projectSlugs: ['demo']
      }
    ]);
  });

  it('lists spreadsheet watch status for operators', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env } = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30
      }
    );

    const response = await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.list'
      }
    );

    expect((response as {
      type: 'control.spreadsheet-watches.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          lastWatchError: string | null;
          projectSlugs: string[];
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        lastWatchError: null,
        projectSlugs: ['demo']
      })
    ]);
  });

  it('lists a shared spreadsheet watch once with every linked project slug', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env } = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:prod')),
      {
        type: 'project.create',
        input: {
          slug: 'prod',
          name: 'Prod',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:prod')),
      {
        type: 'project.table.create',
        projectSlug: 'prod',
        input: {
          tableSlug: 'members',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30
      }
    );

    const response = await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.list'
      }
    );

    expect((response as {
      type: 'control.spreadsheet-watches.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          projectSlugs: string[];
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        projectSlugs: ['demo', 'prod']
      })
    ]);
  });

  it('removes obsolete spreadsheet watches when the project registry no longer references them', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const stopRequests: Array<{ id: string; resourceId: string }> = [];
    const fetchHandler = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/drive/v3/channels/stop')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; resourceId?: string };
        stopRequests.push({
          id: body.id ?? '',
          resourceId: body.resourceId ?? ''
        });
      }

      return fetchHandler(input, init);
    });
    const { env } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    });

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        allowExisting: true,
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-2'
        }
      }
    );

    const response = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    });

    expect((response as {
      type: 'control.spreadsheet-watches.register.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          channelId: string;
          resourceId: string;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-2',
        channelId: 'channel-sheet-2',
        resourceId: 'resource-sheet-2'
      })
    ]);

    expect(stopRequests).toContainEqual({
      id: 'channel-sheet-1',
      resourceId: 'resource-sheet-1'
    });
  });

  it('debounces Drive notifications and auto-reindexes affected tables when the alarm fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T15:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env, controlPlaneNamespace } = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          cacheTtlSeconds: 3600
        }
      }
    );

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {}
      }
    );

    await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30
      }
    );

    vi.setSystemTime(new Date('2026-04-29T15:01:00.000Z'));

    const notifyResponse = await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watch.notify',
        channelId: 'channel-sheet-1',
        resourceId: 'resource-sheet-1',
        resourceState: 'update',
        messageNumber: '2',
        changedAt: '2026-04-29T15:01:00.000Z',
        channelExpiration: 'Fri, 01 May 2026 00:00:00 GMT'
      }
    );

    expect((notifyResponse as {
      type: 'control.spreadsheet-watch.notify.result';
      result: { accepted: boolean; spreadsheetId: string | null; debounceUntil: string | null };
    }).result).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:30.000Z'
    });

    const duplicateResponse = await doRpc<ControlPlaneDoResponse>(
      env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')),
      {
        type: 'control.spreadsheet-watch.notify',
        channelId: 'channel-sheet-1',
        resourceId: 'resource-sheet-1',
        resourceState: 'update',
        messageNumber: '2',
        changedAt: '2026-04-29T15:01:10.000Z',
        channelExpiration: 'Fri, 01 May 2026 00:00:00 GMT'
      }
    );

    expect((duplicateResponse as {
      type: 'control.spreadsheet-watch.notify.result';
      result: { accepted: boolean; spreadsheetId: string | null; debounceUntil: string | null };
    }).result).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:30.000Z'
    });

    const cacheAfterNotify = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheAfterNotify as {
      type: 'table.cache.get.result';
      result: { data: { staleReason: string; externalChange: { pending: boolean; debounceUntil: string | null } } };
    }).result.data).toMatchObject({
      staleReason: 'external-change',
      externalChange: {
        pending: true,
        debounceUntil: '2026-04-29T15:01:30.000Z'
      }
    });

    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'active']
    ];

    vi.setSystemTime(new Date('2026-04-29T15:01:31.000Z'));
    await (controlPlaneNamespace as { triggerAlarm(name: string): Promise<void> }).triggerAlarm('control-plane');

    const cacheAfterAlarm = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheAfterAlarm as {
      type: 'table.cache.get.result';
      result: {
        data: {
          staleReason: string;
          externalChange: { pending: boolean; lastAutoReindexAt: string | null };
          rowCount: number;
        };
      };
    }).result.data).toMatchObject({
      staleReason: 'fresh',
      rowCount: 1,
      externalChange: {
        pending: false,
        lastAutoReindexAt: '2026-04-29T15:01:31.000Z'
      }
    });

    const rowResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.get',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1'
      }
    );

    expect((rowResponse as {
      type: 'table.row.get.result';
      result: { data: { values: { status: string } } };
    }).result.data.values.status).toBe('active');

    vi.useRealTimers();
  });

  it('preserves the stored message number when a notification arrives without one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T15:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    });

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watch.notify',
      channelId: 'channel-sheet-1',
      resourceId: 'resource-sheet-1',
      resourceState: 'update',
      messageNumber: '2',
      changedAt: '2026-04-29T15:01:00.000Z',
      channelExpiration: 'Fri, 01 May 2026 00:00:00 GMT'
    });

    const nullMessageResponse = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watch.notify',
      channelId: 'channel-sheet-1',
      resourceId: 'resource-sheet-1',
      resourceState: 'update',
      messageNumber: null,
      changedAt: '2026-04-29T15:01:10.000Z',
      channelExpiration: 'Fri, 01 May 2026 00:00:00 GMT'
    });

    expect((nullMessageResponse as {
      type: 'control.spreadsheet-watch.notify.result';
      result: { accepted: boolean; spreadsheetId: string | null; debounceUntil: string | null };
    }).result).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:40.000Z'
    });

    const duplicateResponse = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watch.notify',
      channelId: 'channel-sheet-1',
      resourceId: 'resource-sheet-1',
      resourceState: 'update',
      messageNumber: '2',
      changedAt: '2026-04-29T15:01:20.000Z',
      channelExpiration: 'Fri, 01 May 2026 00:00:00 GMT'
    });

    expect((duplicateResponse as {
      type: 'control.spreadsheet-watch.notify.result';
      result: { accepted: boolean; spreadsheetId: string | null; debounceUntil: string | null };
    }).result).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:40.000Z'
    });

    vi.useRealTimers();
  });

  it('renews expiring spreadsheet watches from the control-plane alarm before they lapse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const stopRequests: Array<{ id: string; resourceId: string }> = [];
    const fetchHandler = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/drive/v3/channels/stop')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; resourceId?: string };
        stopRequests.push({
          id: body.id ?? '',
          resourceId: body.resourceId ?? ''
        });
      }

      return fetchHandler(input, init);
    });
    const { env, controlPlaneNamespace } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
    });

    vi.setSystemTime(new Date('2026-04-29T10:05:01.000Z'));
    await (controlPlaneNamespace as { triggerAlarm(name: string): Promise<void> }).triggerAlarm('control-plane');

    const response = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.list'
    });

    expect((response as {
      type: 'control.spreadsheet-watches.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          channelId: string;
          resourceId: string;
          lastWatchError: string | null;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1-2',
        resourceId: 'resource-sheet-1-2',
        lastWatchError: null
      })
    ]);

    expect(stopRequests).toContainEqual({
      id: 'channel-sheet-1',
      resourceId: 'resource-sheet-1'
    });

    vi.useRealTimers();
  });

  it('uses a longer renewal retry window for persistent watch configuration errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', createSheetsAndDriveFetch(sheet));
    const { env, controlPlaneNamespace } = createTestEnv({
      GOOGLE_DRIVE_WEBHOOK_SECRET: undefined
    });
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
    });

    vi.setSystemTime(new Date('2026-04-29T10:05:01.000Z'));
    await (controlPlaneNamespace as { triggerAlarm(name: string): Promise<void>; getAlarm(name: string): number | null }).triggerAlarm('control-plane');

    const response = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.list'
    });

    expect((response as {
      type: 'control.spreadsheet-watches.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          lastWatchError: string | null;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        lastWatchError: 'GOOGLE_DRIVE_WEBHOOK_SECRET is not configured.'
      })
    ]);

    expect(
      (controlPlaneNamespace as { getAlarm(name: string): number | null }).getAlarm('control-plane')
    ).toBe(Date.parse('2026-04-29T11:05:01.000Z'));

    vi.useRealTimers();
  });
});
