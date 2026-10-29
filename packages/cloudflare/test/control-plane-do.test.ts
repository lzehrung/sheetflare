import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toErrorResponse, type ControlPlaneDoResponse, type ProjectDoResponse, type TableDoResponse } from '@sheetflare/contracts';
import { ControlPlaneDO, ProjectDO, TableDO, doRpc, type CloudflareEnv } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';
import { expectRpcResult } from './support/rpc-result';

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
  return {
    env,
    controlPlaneNamespace,
    // Registries written before credential refs were checked at project creation can hold projects that share a
    // spreadsheet under different refs. Registering such a pair is rejected now, so the rows go into storage the way
    // that release wrote them.
    seedRegistryProject(slug: string, spreadsheetId: string, googleCredentialRef: string) {
      controlPlaneNamespace.runSql(
        'control-plane',
        `INSERT INTO project_registry (slug, name, spreadsheet_id, google_credential_ref, table_count, updated_at)
         VALUES (?, ?, ?, ?, 0, '2026-05-01T00:00:00.000Z')`,
        slug,
        slug,
        spreadsheetId,
        googleCredentialRef
      );
    }
  };
}

async function hashApiKeySecret(secret: string) {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
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

  it('schedules renewal from the actual Drive watch expiration instead of the requested duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T20:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const watchMatch = url.match(/\/drive\/v3\/files\/([^/]+)\/watch/);
      if (watchMatch) {
        const spreadsheetId = decodeURIComponent(watchMatch[1] ?? '');
        return Response.json({
          id: `channel-${spreadsheetId}`,
          resourceId: `resource-${spreadsheetId}`,
          resourceUri: `https://www.googleapis.com/drive/v3/files/${spreadsheetId}`,
          expiration: String(Date.parse('2026-05-03T20:00:00.000Z'))
        });
      }

      return fallbackFetch(input, init);
    });
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
        debounceSeconds: 30,
        expirationMs: Date.parse('2026-05-09T20:00:00.000Z')
      }
    );

    expect(
      (controlPlaneNamespace as { getAlarm(name: string): number | null }).getAlarm('control-plane')
    ).toBe(Date.parse('2026-05-03T14:00:00.000Z'));

    vi.useRealTimers();
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

  it('stops and removes known spreadsheet watches on explicit operator request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T18:00:00.000Z'));
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

    const stopped = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.stop',
      input: {
        spreadsheetId: 'sheet-1'
      }
    });

    expect((stopped as {
      type: 'control.spreadsheet-watches.stop.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          channelId: string;
          resourceId: string;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1',
        resourceId: 'resource-sheet-1'
      })
    ]);

    expect(stopRequests).toContainEqual({
      id: 'channel-sheet-1',
      resourceId: 'resource-sheet-1'
    });

    const remaining = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.list'
    });

    expect((remaining as {
      type: 'control.spreadsheet-watches.list.result';
      result: { data: unknown[] };
    }).result.data).toEqual([]);

    const retryAdvice = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.retry-advice.list'
    });

    expect((retryAdvice as {
      type: 'control.spreadsheet-watches.retry-advice.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          status: string;
          lastKnownStoppedAt: string | null;
          lastKnownExpirationAt: string | null;
          safeRetryAt: string | null;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        status: 'cooldown-recommended',
        lastKnownStoppedAt: '2026-05-01T18:00:00.000Z',
        lastKnownExpirationAt: '2026-05-01T00:00:00.000Z',
        safeRetryAt: '2026-05-01T18:15:00.000Z'
      })
    ]);

    vi.useRealTimers();
  });

  it('project deletion revokes project-scoped API keys and stops obsolete spreadsheet watches', async () => {
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
    const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));

    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1'
      }
    });
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.table.create',
      projectSlug: 'demo',
      input: {
        tableSlug: 'users',
        sheetTabName: 'Users'
      }
    });
    const projectKeyResponse = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.create',
      input: {
        name: 'Demo project key',
        projectSlug: 'demo',
        scopes: ['table:read']
      }
    });
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.create',
      input: {
        name: 'Global admin key',
        scopes: ['admin:projects']
      }
    });
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    });

    const projectKey = (projectKeyResponse as {
      type: 'control.api-key.create.result';
      result: { apiKey: string; record: { id: string } };
    }).result;
    const projectKeySecret = projectKey.apiKey.split('.')[1] ?? '';
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.delete',
      projectSlug: 'demo'
    });
    const keys = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-keys.list'
    });
    const verifyProjectKey = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.verify',
      apiKeyId: projectKey.record.id,
      hash: await hashApiKeySecret(projectKeySecret)
    });
    const watches = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.list'
    });

    expect((keys as {
      type: 'control.api-keys.list.result';
      result: { data: Array<{ name: string; revokedAt: string | null }> };
    }).result.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Global admin key',
        revokedAt: null
      }),
      expect.objectContaining({
        name: 'Demo project key',
        revokedAt: expect.any(String)
      })
    ]));
    expect((verifyProjectKey as {
      type: 'control.api-key.verify.result';
      result: { record: unknown };
    }).result.record).toBeNull();
    expect((watches as {
      type: 'control.spreadsheet-watches.list.result';
      result: { data: Array<unknown> };
    }).result.data).toEqual([]);
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

    expect(expectRpcResult(notifyResponse, 'control.spreadsheet-watch.notify.result')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:30.000Z',
      changed: true,
      projectSlugs: ['demo']
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

    expect(expectRpcResult(duplicateResponse, 'control.spreadsheet-watch.notify.result')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:30.000Z',
      changed: false,
      projectSlugs: ['demo']
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

    expect(expectRpcResult(nullMessageResponse, 'control.spreadsheet-watch.notify.result')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:40.000Z',
      changed: true,
      projectSlugs: ['demo']
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

    expect(expectRpcResult(duplicateResponse, 'control.spreadsheet-watch.notify.result')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T15:01:40.000Z',
      changed: false,
      projectSlugs: ['demo']
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

  it('retries watch registration once after stopping the known watch when Google rejects a replacement for file-subscription quota', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const stopRequests: Array<{ id: string; resourceId: string }> = [];
    let watchAttemptCount = 0;
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/sheet-1/watch')) {
        watchAttemptCount += 1;
        if (watchAttemptCount === 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Rate limit exceeded for creating file subscriptions.',
                status: 'PERMISSION_DENIED'
              }
            }),
            {
              headers: {
                'content-type': 'application/json'
              },
              status: 403
            }
          );
        }
      }

      if (url.endsWith('/drive/v3/channels/stop')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; resourceId?: string };
        stopRequests.push({
          id: body.id ?? '',
          resourceId: body.resourceId ?? ''
        });
      }

      return fallbackFetch(input, init);
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
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1-2',
        resourceId: 'resource-sheet-1-2'
      })
    ]);

    expect(stopRequests).toContainEqual({
      id: 'channel-sheet-1',
      resourceId: 'resource-sheet-1'
    });
  });

  it('tombstones the known watch when quota fallback stop succeeds but the replacement still fails', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const stopRequests: Array<{ id: string; resourceId: string }> = [];
    let watchAttemptCount = 0;
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/sheet-1/watch')) {
        watchAttemptCount += 1;
        if (watchAttemptCount >= 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Rate limit exceeded for creating file subscriptions.',
                status: 'PERMISSION_DENIED'
              }
            }),
            {
              headers: {
                'content-type': 'application/json'
              },
              status: 403
            }
          );
        }
      }

      if (url.endsWith('/drive/v3/channels/stop')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string; resourceId?: string };
        stopRequests.push({
          id: body.id ?? '',
          resourceId: body.resourceId ?? ''
        });
      }

      return fallbackFetch(input, init);
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

    await expect(doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    })).rejects.toMatchObject({
      status: 502
    });

    const listResponse = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.list'
    });
    expect((listResponse as {
      type: 'control.spreadsheet-watches.list.result';
      result: { data: Array<unknown> };
    }).result.data).toEqual([]);

    const retryAdviceResponse = await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.retry-advice.list'
    });
    expect((retryAdviceResponse as {
      type: 'control.spreadsheet-watches.retry-advice.list.result';
      result: {
        data: Array<{
          spreadsheetId: string;
          status: string;
          lastKnownStoppedAt: string | null;
          lastKnownExpirationAt: string | null;
        }>;
      };
    }).result.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        status: 'cooldown-recommended',
        lastKnownStoppedAt: expect.any(String),
        lastKnownExpirationAt: expect.any(String)
      })
    ]);

    expect(stopRequests).toContainEqual({
      id: 'channel-sheet-1',
      resourceId: 'resource-sheet-1'
    });
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

  it('waits until after the current watch expires before retrying renewal after Drive subscription quota errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    let watchAttemptCount = 0;
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/sheet-1/watch')) {
        watchAttemptCount += 1;
        if (watchAttemptCount === 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Rate limit exceeded for creating file subscriptions.',
                status: 'PERMISSION_DENIED'
              }
            }),
            {
              headers: {
                'content-type': 'application/json'
              },
              status: 403
            }
          );
        }
      }

      return fallbackFetch(input, init);
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
        lastWatchError: 'Google Drive rate limit exceeded for creating file subscriptions.'
      })
    ]);
    expect(
      (controlPlaneNamespace as { getAlarm(name: string): number | null }).getAlarm('control-plane')
    ).toBe(Date.parse('2026-04-29T10:25:00.000Z'));

    vi.useRealTimers();
  });

  it('returns structured Google watch registration errors with the upstream status', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/sheet-1/watch')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: 'The caller does not have permission',
              status: 'PERMISSION_DENIED'
            }
          }),
          {
            headers: {
              'content-type': 'application/json'
            },
            status: 403
          }
        );
      }

      return createSheetsAndDriveFetch(sheet)(input, init);
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

    const response = await controlPlane.fetch('https://do.internal/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30
      } satisfies {
        type: 'control.spreadsheet-watches.register';
        webhookUrl: string;
        webhookToken: string;
        debounceSeconds: number;
      })
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'BAD_GATEWAY',
        message: 'Google Sheets authentication or permission check failed.',
        details: expect.objectContaining({
          status: 403
        })
      }
    });
  });

  it('relays Google watch registration failures to RPC callers without upstream details', async () => {
    const sheet: SheetState = {
      rows: [['_id', 'status']]
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/drive/v3/files/sheet-1/watch')) {
        return Response.json({
          error: {
            code: 403,
            message: 'Drive API has not been used in project 123456789012 before or it is disabled.',
            status: 'PERMISSION_DENIED'
          }
        }, { status: 403 });
      }

      return createSheetsAndDriveFetch(sheet)(input, init);
    });
    const { env } = createTestEnv();

    await doRpc<ProjectDoResponse>(env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')), {
      type: 'project.create',
      input: { slug: 'demo', name: 'Demo', spreadsheetId: 'sheet-1' }
    });
    const failure = await doRpc<ControlPlaneDoResponse>(env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane')), {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30
    }).then(
      () => {
        throw new Error('Expected watch registration to fail.');
      },
      (error: unknown) => error
    );

    expect(toErrorResponse(failure)).toEqual({
      status: 502,
      body: {
        error: {
          code: 'BAD_GATEWAY',
          message: 'Google Sheets authentication or permission check failed.',
          details: null
        }
      }
    });
  });
});

describe('ControlPlaneDO project removal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('deletes a project when Google cannot stop its watch and retries the stop from the alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ]
    };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    const stoppedChannels: string[] = [];
    let googleStopFails = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/drive/v3/channels/stop')) {
        stoppedChannels.push(String(JSON.parse(String(init?.body ?? '{}')).id));
        if (googleStopFails) {
          return Response.json({ error: { code: 500, message: 'Backend Error', status: 'INTERNAL' } }, { status: 500 });
        }
      }

      return fallbackFetch(input, init);
    });
    const { env, controlPlaneNamespace } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.create',
      input: { slug: 'demo', name: 'Demo', spreadsheetId: 'sheet-1' }
    });
    await doRpc<ProjectDoResponse>(project, {
      type: 'project.table.create',
      projectSlug: 'demo',
      input: { tableSlug: 'users', sheetTabName: 'Users' }
    });
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-05-08T10:00:00.000Z')
    });

    const deleted = expectRpcResult(
      await doRpc<ProjectDoResponse>(project, { type: 'project.delete', projectSlug: 'demo' }),
      'project.delete.result'
    );

    expect(deleted).toEqual({ ok: true, deletedProject: 'demo', deletedTables: ['users'] });
    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data).toEqual([]);
    expect(stoppedChannels).toEqual(['channel-sheet-1']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"drive.watch.stop.failed"'));
    expect(controlPlaneNamespace.getAlarm('control-plane')).toBe(Date.parse('2026-05-01T10:01:00.000Z'));

    vi.setSystemTime(new Date('2026-05-01T10:01:00.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect(stoppedChannels).toEqual(['channel-sheet-1', 'channel-sheet-1']);
    expect(controlPlaneNamespace.getAlarm('control-plane')).toBe(Date.parse('2026-05-01T10:03:00.000Z'));

    googleStopFails = false;
    vi.setSystemTime(new Date('2026-05-01T10:03:00.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect(stoppedChannels).toEqual(['channel-sheet-1', 'channel-sheet-1', 'channel-sheet-1']);
    expect(controlPlaneNamespace.getAlarm('control-plane')).toBeNull();
  });

  it('deletes a project while other projects share a spreadsheet under conflicting credential refs', async () => {
    vi.stubGlobal('fetch', createSheetsAndDriveFetch({ rows: [['_id']] }));
    const { env, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    seedRegistryProject('alpha', 'sheet-1', 'default');
    seedRegistryProject('beta', 'sheet-1', 'other');
    const gamma = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:gamma'));
    await doRpc<ProjectDoResponse>(gamma, {
      type: 'project.create',
      input: { slug: 'gamma', name: 'Gamma', spreadsheetId: 'sheet-2' }
    });

    await expect(doRpc<ProjectDoResponse>(gamma, { type: 'project.delete', projectSlug: 'gamma' }))
      .resolves.toMatchObject({ type: 'project.delete.result' });
    await expect(doRpc<ProjectDoResponse>(gamma, { type: 'project.delete', projectSlug: 'gamma' }))
      .resolves.toMatchObject({ type: 'project.delete.result' });

    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.projects.list' }),
      'control.projects.list.result'
    ).data.map((project) => project.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('registers the healthy spreadsheet when another spreadsheet has conflicting credential refs', async () => {
    const watchedSpreadsheetIds: string[] = [];
    const sheet: SheetState = { rows: [['_id']] };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const watchMatch = url.match(/\/drive\/v3\/files\/([^/]+)\/watch/);
      if (watchMatch) {
        watchedSpreadsheetIds.push(decodeURIComponent(watchMatch[1] ?? ''));
      }
      return fallbackFetch(input, init);
    });
    const { env, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    // A current upsert cannot create this pair. The rows are what a registry saved before the check still holds.
    seedRegistryProject('alpha', 'sheet-conflict', 'default');
    seedRegistryProject('beta', 'sheet-conflict', 'other');
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.project.upsert',
      summary: {
        slug: 'gamma',
        name: 'gamma',
        spreadsheetId: 'sheet-healthy',
        googleCredentialRef: 'default',
        tableCount: 0,
        updatedAt: '2026-04-29T10:00:00.000Z'
      }
    });

    const registered = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30,
        expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
      }),
      'control.spreadsheet-watches.register.result'
    );

    const conflictMessage = 'Spreadsheet sheet-conflict is registered with conflicting Google credential refs "default", "other". Projects that share a spreadsheet must use the same credential ref.';
    expect(watchedSpreadsheetIds).toEqual(['sheet-healthy']);
    expect(registered.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        projectSlugs: ['alpha', 'beta'],
        lastWatchError: conflictMessage
      }),
      expect.objectContaining({
        spreadsheetId: 'sheet-healthy',
        googleCredentialRef: 'default',
        channelId: 'channel-sheet-healthy',
        resourceId: 'resource-sheet-healthy',
        lastWatchError: null,
        projectSlugs: ['gamma']
      })
    ]);
    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data).toEqual(registered.data);
  });

  it('renews the healthy spreadsheet when another spreadsheet has conflicting credential refs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const watchedSpreadsheetIds: string[] = [];
    const sheet: SheetState = { rows: [['_id']] };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const watchMatch = url.match(/\/drive\/v3\/files\/([^/]+)\/watch/);
      if (watchMatch) {
        watchedSpreadsheetIds.push(decodeURIComponent(watchMatch[1] ?? ''));
      }
      return fallbackFetch(input, init);
    });
    const { env, controlPlaneNamespace, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    const projects = [
      { slug: 'healthy', spreadsheetId: 'sheet-healthy', googleCredentialRef: 'default' },
      { slug: 'alpha', spreadsheetId: 'sheet-conflict', googleCredentialRef: 'default' }
    ];
    for (const project of projects) {
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.project.upsert',
        summary: {
          slug: project.slug,
          name: project.slug,
          spreadsheetId: project.spreadsheetId,
          googleCredentialRef: project.googleCredentialRef,
          tableCount: 0,
          updatedAt: '2026-04-29T10:00:00.000Z'
        }
      });
    }

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
    });

    // Upsert rejects a new conflicting ref. A registry saved before that check can still hold one, and renewal must notice it.
    seedRegistryProject('beta', 'sheet-conflict', 'other');

    vi.setSystemTime(new Date('2026-04-29T10:05:01.000Z'));
    await (controlPlaneNamespace as { triggerAlarm(name: string): Promise<void> }).triggerAlarm('control-plane');

    const watches = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data;
    expect(watchedSpreadsheetIds).toEqual(['sheet-conflict', 'sheet-healthy', 'sheet-healthy']);
    expect(watches).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        channelId: 'channel-sheet-conflict',
        lastWatchError: 'Spreadsheet sheet-conflict is registered with conflicting Google credential refs "default", "other". Projects that share a spreadsheet must use the same credential ref.',
        projectSlugs: ['alpha', 'beta']
      }),
      expect.objectContaining({
        spreadsheetId: 'sheet-healthy',
        channelId: 'channel-sheet-healthy-2',
        lastWatchError: null,
        projectSlugs: ['healthy']
      })
    ]);

    vi.useRealTimers();
  });

  it('registers a previously conflicting spreadsheet after its credential refs are aligned', async () => {
    const stoppedChannelIds: string[] = [];
    const sheet: SheetState = { rows: [['_id']] };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/drive/v3/channels/stop')) {
        const parsed: unknown = JSON.parse(String(init?.body ?? '{}'));
        if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string') {
          stoppedChannelIds.push(parsed.id);
        }
      }
      return fallbackFetch(input, init);
    });
    const { env, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    seedRegistryProject('alpha', 'sheet-conflict', 'default');
    seedRegistryProject('beta', 'sheet-conflict', 'other');
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.project.upsert',
      summary: {
        slug: 'gamma',
        name: 'gamma',
        spreadsheetId: 'sheet-healthy',
        googleCredentialRef: 'default',
        tableCount: 0,
        updatedAt: '2026-04-29T10:00:00.000Z'
      }
    });
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
    });

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.project.upsert',
      summary: {
        slug: 'beta',
        name: 'beta',
        spreadsheetId: 'sheet-conflict',
        googleCredentialRef: 'default',
        tableCount: 0,
        updatedAt: '2026-04-29T10:04:00.000Z'
      }
    });
    const registered = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.register',
        webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
        webhookToken: 'secret-token',
        debounceSeconds: 30,
        expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
      }),
      'control.spreadsheet-watches.register.result'
    );

    expect(stoppedChannelIds).not.toContain('credential-conflict:sheet-conflict');
    expect(registered.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        channelId: 'channel-sheet-conflict',
        googleCredentialRef: 'default',
        lastWatchError: null,
        projectSlugs: ['alpha', 'beta']
      }),
      expect.objectContaining({
        spreadsheetId: 'sheet-healthy',
        channelId: 'channel-sheet-healthy-2',
        lastWatchError: null,
        projectSlugs: ['gamma']
      })
    ]);
  });

  const conflictPlaceholderMessage = 'Spreadsheet sheet-conflict is registered with conflicting Google credential refs "default", "other". Projects that share a spreadsheet must use the same credential ref.';

  function createConflictRegistry() {
    const driveCalls: string[] = [];
    const fallbackFetch = createSheetsAndDriveFetch({ rows: [['_id']] });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/') && url.includes('/watch')) {
        driveCalls.push(`watch ${url}`);
      }
      if (url.endsWith('/drive/v3/channels/stop')) {
        driveCalls.push(`stop ${String(init?.body ?? '')}`);
      }
      return fallbackFetch(input, init);
    });
    const { env, controlPlaneNamespace, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    seedRegistryProject('alpha', 'sheet-conflict', 'default');
    seedRegistryProject('beta', 'sheet-conflict', 'other');
    return { driveCalls, env, controlPlane, controlPlaneNamespace };
  }

  async function registerConflictPlaceholder(controlPlane: {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }) {
    return doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.register',
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs: Date.parse('2026-04-29T10:10:00.000Z')
    });
  }

  it('reports a credential-ref conflict instead of an active watch when only a conflict placeholder exists', async () => {
    const { controlPlane } = createConflictRegistry();
    await registerConflictPlaceholder(controlPlane);

    const advice = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.retry-advice.list'
      }),
      'control.spreadsheet-watches.retry-advice.list.result'
    );

    expect(advice.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        status: 'credential-conflict',
        currentWatchExpirationAt: null,
        safeRetryAt: null,
        projectSlugs: ['alpha', 'beta']
      })
    ]);
    expect(advice.data[0]?.note).toContain('conflicting Google credential refs "default", "other"');
    expect(advice.data[0]?.note).toContain('No Google Drive watch is active');
    expect(advice.data[0]?.note).toContain('Align googleCredentialRef');
    expect(JSON.stringify(advice)).not.toContain('active-watch-present');
  });

  it('does not call Google when renewing or stopping a credential-conflict placeholder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const { driveCalls, controlPlane, controlPlaneNamespace } = createConflictRegistry();
    await registerConflictPlaceholder(controlPlane);
    expect(driveCalls).toEqual([]);

    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');
    expect(driveCalls).toEqual([]);

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.project.upsert',
      summary: {
        slug: 'beta',
        name: 'beta',
        spreadsheetId: 'sheet-conflict',
        googleCredentialRef: 'default',
        tableCount: 0,
        updatedAt: '2026-05-06T10:01:00.000Z'
      }
    });
    const notified = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watch.notify',
        channelId: 'credential-conflict:sheet-conflict',
        resourceId: 'credential-conflict:sheet-conflict',
        resourceState: 'sync',
        messageNumber: '1',
        changedAt: '2026-05-06T10:02:00.000Z',
        channelExpiration: '2026-05-06T12:00:00.000Z'
      }),
      'control.spreadsheet-watch.notify.result'
    );
    expect(notified.accepted).toBe(false);

    await controlPlaneNamespace.triggerAlarm('control-plane');
    expect(driveCalls).toEqual([]);
    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        channelId: 'credential-conflict:sheet-conflict',
        lastWatchError: conflictPlaceholderMessage
      })
    ]);

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.spreadsheet-watches.stop',
      input: {}
    });
    expect(driveCalls).toEqual([]);
    const advice = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.retry-advice.list'
      }),
      'control.spreadsheet-watches.retry-advice.list.result'
    );
    expect(advice.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        status: 'ready-to-retry',
        currentWatchExpirationAt: null
      })
    ]);
    expect(JSON.stringify(advice)).not.toContain('active-watch-present');
    expect(JSON.stringify(advice)).not.toContain('cooldown-recommended');
  });

  it('replaces a credential-conflict placeholder with a real watch after the refs are aligned', async () => {
    const { driveCalls, controlPlane } = createConflictRegistry();
    await registerConflictPlaceholder(controlPlane);
    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        channelId: 'credential-conflict:sheet-conflict',
        lastWatchError: conflictPlaceholderMessage
      })
    ]);

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.project.upsert',
      summary: {
        slug: 'beta',
        name: 'beta',
        spreadsheetId: 'sheet-conflict',
        googleCredentialRef: 'default',
        tableCount: 0,
        updatedAt: '2026-04-29T10:04:00.000Z'
      }
    });
    const registered = expectRpcResult(
      await registerConflictPlaceholder(controlPlane),
      'control.spreadsheet-watches.register.result'
    );

    expect(driveCalls.some((call) => call.startsWith('stop '))).toBe(false);
    expect(registered.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        channelId: 'channel-sheet-conflict',
        googleCredentialRef: 'default',
        resourceId: 'resource-sheet-conflict',
        lastWatchError: null,
        projectSlugs: ['alpha', 'beta']
      })
    ]);
    const advice = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.retry-advice.list'
      }),
      'control.spreadsheet-watches.retry-advice.list.result'
    );
    expect(advice.data).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-conflict',
        status: 'active-watch-present',
        note: 'A known Drive watch is still active for this spreadsheet.',
        projectSlugs: ['alpha', 'beta']
      })
    ]);
  });

  it('drops a conflict placeholder without a stopped-channel tombstone when its projects are gone', async () => {
    const { driveCalls, controlPlane } = createConflictRegistry();
    await registerConflictPlaceholder(controlPlane);

    await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.project.delete', projectSlug: 'alpha' });
    await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.project.delete', projectSlug: 'beta' });

    expect(driveCalls).toEqual([]);
    expect(expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data).toEqual([]);
    const advice = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.spreadsheet-watches.retry-advice.list'
      }),
      'control.spreadsheet-watches.retry-advice.list.result'
    );
    expect(advice.data).toEqual([]);
  });
});

describe('ControlPlaneDO project reservations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createProjectRegistry() {
    const { env, controlPlaneNamespace, seedRegistryProject } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    return {
      controlPlane,
      controlPlaneNamespace,
      seedRegistryProject,
      reserve: (projectSlug: string, spreadsheetId: string, googleCredentialRef: string, revokeApiKeys = false) =>
        doRpc<ControlPlaneDoResponse>(controlPlane, {
          type: 'control.project.reserve',
          projectSlug,
          spreadsheetId,
          googleCredentialRef,
          revokeApiKeys
        }),
      release: (projectSlug: string) =>
        doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.project.release', projectSlug }),
      register: (slug: string, spreadsheetId: string, googleCredentialRef: string) =>
        doRpc<ControlPlaneDoResponse>(controlPlane, {
          type: 'control.project.upsert',
          summary: { slug, name: slug, spreadsheetId, googleCredentialRef, tableCount: 0, updatedAt: '2026-05-01T00:00:00.000Z' }
        }),
      async listRegistered() {
        const registry = expectRpcResult(
          await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.projects.list' }),
          'control.projects.list.result'
        );
        return registry.data
          .map((project) => `${project.slug}:${project.spreadsheetId}:${project.googleCredentialRef}`)
          .sort();
      }
    };
  }

  it('rejects a spreadsheet reserved under another credential ref and records nothing for the rejected project', async () => {
    const { reserve, release } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');

    await expect(reserve('beta', 'sheet-1', 'other')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { spreadsheetId: 'sheet-1', googleCredentialRef: 'other', registeredGoogleCredentialRefs: ['default'] }
    });

    // beta left no claim behind: once alpha lets go, the spreadsheet is free for any ref.
    await release('alpha');
    await expect(reserve('gamma', 'sheet-1', 'third')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
  });

  it('lets projects reserve one spreadsheet under the same credential ref and different spreadsheets under different refs', async () => {
    const { reserve } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');

    await expect(reserve('beta', 'sheet-1', 'default')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
    await expect(reserve('gamma', 'sheet-2', 'other')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
  });

  it('replaces the reservation of a slug that reserves again', async () => {
    const { reserve } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');

    // A retried create does not conflict with its own earlier reservation, and a create that moved takes its claim along.
    await reserve('alpha', 'sheet-1', 'default');
    await reserve('alpha', 'sheet-2', 'other');

    await expect(reserve('beta', 'sheet-1', 'third')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
    await expect(reserve('gamma', 'sheet-2', 'default')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { registeredGoogleCredentialRefs: ['other'] }
    });
  });

  it('drops a reservation when it is released or when its slug is deleted', async () => {
    const { controlPlane, reserve, release } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');
    await release('alpha');
    await reserve('beta', 'sheet-1', 'other');
    await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.project.delete', projectSlug: 'beta' });

    // Neither reservation outlived its release or delete, and releasing a slug that holds none is not an error.
    await expect(reserve('gamma', 'sheet-1', 'third')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
    await expect(release('nobody')).resolves.toMatchObject({ type: 'control.project.release.result' });
  });

  it('stops holding a spreadsheet for a reservation that expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const { reserve } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');

    vi.setSystemTime(new Date('2026-05-01T10:04:59.999Z'));
    await expect(reserve('beta', 'sheet-1', 'other')).rejects.toMatchObject({ code: 'CONFLICT' });

    vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
    await expect(reserve('beta', 'sheet-1', 'other')).resolves.toMatchObject({ type: 'control.project.reserve.result' });
  });

  it('revokes the leftover keys of a slug only when its reservation is accepted', async () => {
    const { controlPlane, reserve } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');
    const created = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.api-key.create',
        input: { name: 'Beta reader', projectSlug: 'beta', scopes: ['table:read'] }
      }),
      'control.api-key.create.result'
    );
    const readRevokedAt = async () => expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.api-key.get', apiKeyId: created.record.id }),
      'control.api-key.get.result'
    ).record?.revokedAt;

    await expect(reserve('beta', 'sheet-1', 'other', true)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readRevokedAt()).toBeNull();

    await reserve('beta', 'sheet-1', 'default', true);
    expect(await readRevokedAt()).toEqual(expect.any(String));
  });

  it('rejects registering a project under a credential ref that conflicts with a registered or reserved project', async () => {
    const { reserve, register, listRegistered } = createProjectRegistry();
    await register('alpha', 'sheet-1', 'default');
    await reserve('gamma', 'sheet-2', 'default');

    await expect(register('beta', 'sheet-1', 'other')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { spreadsheetId: 'sheet-1', googleCredentialRef: 'other', registeredGoogleCredentialRefs: ['default'] }
    });
    await expect(register('delta', 'sheet-2', 'other')).rejects.toMatchObject({ code: 'CONFLICT' });

    // A rejected registration writes nothing, and a project that uses the spreadsheet's ref registers.
    expect(await listRegistered()).toEqual(['alpha:sheet-1:default']);
    await expect(register('epsilon', 'sheet-1', 'default')).resolves.toMatchObject({ type: 'control.project.upsert.result' });
  });

  it('ends the reservation of a project when it registers and leaves its claim to the registry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const { controlPlaneNamespace, reserve, register } = createProjectRegistry();
    await reserve('alpha', 'sheet-1', 'default');
    await register('alpha', 'sheet-1', 'default');

    expect(controlPlaneNamespace.runSql('control-plane', 'SELECT slug FROM project_reservations')).toEqual([]);
    // The registry holds the spreadsheet well past the lifetime of the reservation that preceded it.
    vi.setSystemTime(new Date('2026-05-01T11:00:00.000Z'));
    await expect(reserve('beta', 'sheet-1', 'other')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps projects of a registry that already conflicts updatable and lets operators converge it', async () => {
    const { seedRegistryProject, register, listRegistered } = createProjectRegistry();
    seedRegistryProject('alpha', 'sheet-1', 'default');
    seedRegistryProject('beta', 'sheet-1', 'other');

    // Registering the pairing a project already has is not a new claim. A third ref is, and conflicts, while a ref the
    // spreadsheet already has converges the registry.
    await expect(register('beta', 'sheet-1', 'other')).resolves.toMatchObject({ type: 'control.project.upsert.result' });
    await expect(register('beta', 'sheet-1', 'third')).rejects.toMatchObject({ code: 'CONFLICT' });
    await register('beta', 'sheet-1', 'default');

    expect(await listRegistered()).toEqual(['alpha:sheet-1:default', 'beta:sheet-1:default']);
  });
});

describe('ControlPlaneDO Drive reindex', () => {
  const webhookUrl = 'https://sheetflare.example/v1/system/google/drive/notifications';

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function getControlPlane(env: CloudflareEnv) {
    return env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
  }

  function getTable(env: CloudflareEnv, projectSlug: string, tableSlug: string) {
    return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
  }

  async function createWatchedTables(
    env: CloudflareEnv,
    tables: Array<{ projectSlug: string; tableSlug: string; sheetTabName?: string }>,
    expirationMs = Date.parse('2026-05-06T10:00:00.000Z')
  ) {
    for (const { projectSlug, tableSlug, sheetTabName = 'Users' } of tables) {
      const project = env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
      await doRpc<ProjectDoResponse>(project, {
        type: 'project.create',
        allowExisting: true,
        input: { slug: projectSlug, name: projectSlug, spreadsheetId: 'sheet-1' }
      });
      await doRpc<ProjectDoResponse>(project, {
        type: 'project.table.create',
        projectSlug,
        input: { tableSlug, sheetTabName, cacheTtlSeconds: 3600 }
      });
    }

    await doRpc<ControlPlaneDoResponse>(getControlPlane(env), {
      type: 'control.spreadsheet-watches.register',
      webhookUrl,
      webhookToken: 'secret-token',
      debounceSeconds: 30,
      expirationMs
    });
  }

  async function notifyChange(env: CloudflareEnv, messageNumber: string, changedAt: string) {
    return expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(getControlPlane(env), {
        type: 'control.spreadsheet-watch.notify',
        channelId: 'channel-sheet-1',
        resourceId: 'resource-sheet-1',
        resourceState: 'update',
        messageNumber,
        changedAt,
        channelExpiration: null
      }),
      'control.spreadsheet-watch.notify.result'
    );
  }

  async function getWatch(env: CloudflareEnv) {
    const [watch] = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(getControlPlane(env), { type: 'control.spreadsheet-watches.list' }),
      'control.spreadsheet-watches.list.result'
    ).data;
    return watch;
  }

  async function getRowStatus(env: CloudflareEnv, projectSlug: string, tableSlug: string) {
    return expectRpcResult(
      await doRpc<TableDoResponse>(getTable(env, projectSlug, tableSlug), {
        type: 'table.row.get',
        projectSlug,
        tableSlug,
        rowId: 'row-1'
      }),
      'table.row.get.result'
    ).data.values.status;
  }

  function readLogEvents(spy: { mock: { calls: unknown[][] } }, event: string) {
    return spy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes(`"event":"${event}"`))
      .map((line) => JSON.parse(line));
  }

  it('keeps reindexing later tables after one fails and backs off its retries up to a cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'v1']
      ]
    };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    let brokenTabReadable = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.includes('?fields=sheets.properties')) {
        return Response.json({
          sheets: [
            { properties: { title: 'Broken', sheetId: 2, sheetType: 'GRID' } },
            { properties: { title: 'Users', sheetId: 1, sheetType: 'GRID' } }
          ]
        });
      }

      if (url.includes("/values/'Broken'")) {
        return brokenTabReadable
          ? Response.json({ values: [['_id', 'status'], ['row-1', 'b1']] })
          : Response.json({
            error: { code: 403, message: 'Project 123456789012 cannot read Broken', status: 'PERMISSION_DENIED' }
          }, { status: 403 });
      }

      return fallbackFetch(input, init);
    });
    const { env, controlPlaneNamespace } = createTestEnv();
    await createWatchedTables(env, [
      { projectSlug: 'a-proj', tableSlug: 'broken', sheetTabName: 'Broken' },
      { projectSlug: 'z-proj', tableSlug: 'healthy' }
    ]);

    brokenTabReadable = false;
    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'v2']
    ];
    await notifyChange(env, '2', '2026-04-29T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-04-29T10:00:30.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    // Reading the cache status does not sync, so this shows the alarm itself reindexed the later table.
    expect(expectRpcResult(
      await doRpc<TableDoResponse>(getTable(env, 'z-proj', 'healthy'), {
        type: 'table.cache.get',
        projectSlug: 'z-proj',
        tableSlug: 'healthy'
      }),
      'table.cache.get.result'
    ).data).toMatchObject({
      staleReason: 'fresh',
      externalChange: { pending: false, lastAutoReindexAt: '2026-04-29T10:00:30.000Z' }
    });
    expect(await getRowStatus(env, 'z-proj', 'healthy')).toBe('v2');
    expect(await getWatch(env)).toMatchObject({
      pendingChangedAt: '2026-04-29T10:00:00.000Z',
      debounceUntil: '2026-04-29T10:01:00.000Z',
      lastReindexError: 'a-proj/broken: Google Sheets authentication or permission check failed.'
    });
    expect(readLogEvents(errorSpy, 'drive.reindex.failed')).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        projectSlug: 'a-proj',
        tableSlug: 'broken',
        attempt: 1,
        nextAttemptAt: '2026-04-29T10:01:00.000Z'
      })
    ]);

    const retryDelaysSeconds: number[] = [];
    for (let retry = 0; retry < 8; retry += 1) {
      const dueAt = (await getWatch(env))?.debounceUntil ?? '';
      vi.setSystemTime(new Date(dueAt));
      await controlPlaneNamespace.triggerAlarm('control-plane');
      retryDelaysSeconds.push((Date.parse((await getWatch(env))?.debounceUntil ?? '') - Date.parse(dueAt)) / 1000);
    }

    expect(retryDelaysSeconds).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600]);
    expect(controlPlaneNamespace.getAlarm('control-plane')).toBe(Date.parse((await getWatch(env))?.debounceUntil ?? ''));

    brokenTabReadable = true;
    vi.setSystemTime(new Date((await getWatch(env))?.debounceUntil ?? ''));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect(await getWatch(env)).toMatchObject({ pendingChangedAt: null, debounceUntil: null, lastReindexError: null });
    expect(await getRowStatus(env, 'a-proj', 'broken')).toBe('b1');

    brokenTabReadable = false;
    const changedAt = new Date().toISOString();
    await notifyChange(env, '3', changedAt);
    vi.setSystemTime(Date.parse(changedAt) + 30_000);
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect(Date.parse((await getWatch(env))?.debounceUntil ?? '') - Date.now()).toBe(30_000);
  });

  it('stores a generic reindex error for unexpected failures and keeps the detail in the log', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', createSheetsAndDriveFetch({ rows: [['_id', 'status'], ['row-1', 'v1']] }));
    const { env, controlPlaneNamespace } = createTestEnv();
    await createWatchedTables(env, [{ projectSlug: 'demo', tableSlug: 'users' }]);
    const tableNamespace = env.TABLE_DO;
    // The table binding fails the way a reset Durable Object does: the RPC throws instead of answering.
    env.TABLE_DO = {
      idFromName: (name: string) => tableNamespace.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = tableNamespace.get(id);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            if (String(init?.body ?? '').includes('"type":"table.reindex"')) {
              throw new Error('Network connection lost to 10.1.2.3:443.');
            }

            return stub.fetch(input, init);
          }
        };
      }
    } as never;

    await notifyChange(env, '2', '2026-04-29T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-04-29T10:00:30.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect((await getWatch(env))?.lastReindexError).toBe(
      'demo/users: Reindex failed unexpectedly. See the drive.reindex.failed log event for details.'
    );
    expect(readLogEvents(errorSpy, 'drive.reindex.failed')).toEqual([
      expect.objectContaining({
        projectSlug: 'demo',
        tableSlug: 'users',
        errorMessage: 'Network connection lost to 10.1.2.3:443.'
      })
    ]);
  });

  it('stores only the contract message when a watch renewal fails and logs drive.watch.renew.failed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fallbackFetch = createSheetsAndDriveFetch({ rows: [['_id', 'status'], ['row-1', 'v1']] });
    let renewalRejected = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (renewalRejected && String(input).includes('/drive/v3/files/sheet-1/watch')) {
        return Response.json({
          error: { code: 403, message: 'Drive API is disabled in project 123456789012.', status: 'PERMISSION_DENIED' }
        }, { status: 403 });
      }

      return fallbackFetch(input, init);
    });
    const { env, controlPlaneNamespace } = createTestEnv();
    await createWatchedTables(env, [{ projectSlug: 'demo', tableSlug: 'users' }], Date.parse('2026-04-29T10:10:00.000Z'));

    renewalRejected = true;
    vi.setSystemTime(new Date('2026-04-29T10:05:01.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect((await getWatch(env))?.lastWatchError).toBe('Google Sheets authentication or permission check failed.');
    expect(readLogEvents(errorSpy, 'drive.watch.renew.failed')).toEqual([
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1',
        errorCode: 'BAD_GATEWAY'
      })
    ]);
  });

  it('reports whether a notification changed anything and which projects share the spreadsheet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    vi.stubGlobal('fetch', createSheetsAndDriveFetch({ rows: [['_id', 'status'], ['row-1', 'v1']] }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = createTestEnv();
    await createWatchedTables(env, [
      { projectSlug: 'demo', tableSlug: 'users' },
      { projectSlug: 'prod', tableSlug: 'members' }
    ]);
    const notify = async (resourceState: string, messageNumber: string, channelId = 'channel-sheet-1') => expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(getControlPlane(env), {
        type: 'control.spreadsheet-watch.notify',
        channelId,
        resourceId: 'resource-sheet-1',
        resourceState,
        messageNumber,
        changedAt: new Date().toISOString(),
        channelExpiration: null
      }),
      'control.spreadsheet-watch.notify.result'
    );

    expect(await notify('sync', '1')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: null,
      changed: false,
      projectSlugs: ['demo', 'prod']
    });
    expect(await notify('update', '2')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T10:00:30.000Z',
      changed: true,
      projectSlugs: ['demo', 'prod']
    });
    vi.setSystemTime(new Date('2026-04-29T10:00:05.000Z'));
    expect(await notify('update', '2')).toEqual({
      accepted: true,
      spreadsheetId: 'sheet-1',
      debounceUntil: '2026-04-29T10:00:30.000Z',
      changed: false,
      projectSlugs: ['demo', 'prod']
    });
    expect(await notify('update', '1')).toMatchObject({ accepted: true, changed: false });
    expect(await notify('update', '3', 'channel-unknown')).toEqual({
      accepted: false,
      spreadsheetId: null,
      debounceUntil: null,
      changed: false,
      projectSlugs: []
    });
  });

  it('logs notifications for unknown channels or resources as drive.notification.rejected', async () => {
    vi.stubGlobal('fetch', createSheetsAndDriveFetch({ rows: [['_id', 'status'], ['row-1', 'v1']] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env } = createTestEnv();
    await createWatchedTables(env, [{ projectSlug: 'demo', tableSlug: 'users' }]);
    const notify = async (channelId: string, resourceId: string) => expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(getControlPlane(env), {
        type: 'control.spreadsheet-watch.notify',
        channelId,
        resourceId,
        resourceState: 'update',
        messageNumber: '2',
        changedAt: '2026-04-29T10:00:00.000Z',
        channelExpiration: null
      }),
      'control.spreadsheet-watch.notify.result'
    );

    expect(await notify('channel-unknown', 'resource-sheet-1')).toMatchObject({ accepted: false });
    expect(await notify('channel-sheet-1', 'resource-other')).toMatchObject({ accepted: false });
    expect(readLogEvents(warnSpy, 'drive.notification.rejected')).toEqual([
      expect.objectContaining({ channelId: 'channel-unknown', resourceId: 'resource-sheet-1', reason: 'unknown-channel' }),
      expect.objectContaining({ channelId: 'channel-sheet-1', resourceId: 'resource-other', reason: 'resource-mismatch' })
    ]);
  });

  it('keeps a notification that arrives during an alarm reindex pending and re-arms the alarm for it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00.000Z'));
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'v1']
      ]
    };
    const fallbackFetch = createSheetsAndDriveFetch(sheet);
    const dataReadHeld = Promise.withResolvers<void>();
    const dataReadReleased = Promise.withResolvers<void>();
    let holdNextDataRead = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fallbackFetch(input, init);
      if (holdNextDataRead && decodeURIComponent(String(input)).includes("/values/'Users'!A")) {
        holdNextDataRead = false;
        dataReadHeld.resolve();
        await dataReadReleased.promise;
      }

      return response;
    });
    const { env, controlPlaneNamespace } = createTestEnv();
    await createWatchedTables(env, [{ projectSlug: 'demo', tableSlug: 'users' }]);
    await notifyChange(env, '2', '2026-04-29T10:00:00.000Z');

    vi.setSystemTime(new Date('2026-04-29T10:00:31.000Z'));
    holdNextDataRead = true;
    const alarm = controlPlaneNamespace.triggerAlarm('control-plane');
    await dataReadHeld.promise;

    // The reindex already holds the v1 snapshot when the sheet changes again.
    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'v2']
    ];
    vi.setSystemTime(new Date('2026-04-29T10:00:32.000Z'));
    await notifyChange(env, '3', '2026-04-29T10:00:32.000Z');
    dataReadReleased.resolve();
    await alarm;

    expect(await getWatch(env)).toMatchObject({
      pendingChangedAt: '2026-04-29T10:00:32.000Z',
      debounceUntil: '2026-04-29T10:01:02.000Z',
      lastReindexCompletedAt: '2026-04-29T10:00:32.000Z',
      lastReindexError: null
    });
    expect(controlPlaneNamespace.getAlarm('control-plane')).toBe(Date.parse('2026-04-29T10:01:02.000Z'));

    vi.setSystemTime(new Date('2026-04-29T10:01:02.000Z'));
    await controlPlaneNamespace.triggerAlarm('control-plane');

    expect(await getWatch(env)).toMatchObject({ pendingChangedAt: null, debounceUntil: null });
    expect(await getRowStatus(env, 'demo', 'users')).toBe('v2');
  });
});

describe('ControlPlaneDO API key lifecycle', () => {
  it('keeps the first revocation timestamp when a key is revoked again', async () => {
    const { env } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
    const created = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, {
        type: 'control.api-key.create',
        input: { name: 'Demo reader', projectSlug: 'demo', scopes: ['table:read'] }
      }),
      'control.api-key.create.result'
    );

    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.revoke',
      apiKeyId: created.record.id,
      revokedAt: '2026-10-01T00:00:00.000Z'
    });
    await doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.revoke',
      apiKeyId: created.record.id,
      revokedAt: '2026-10-02T00:00:00.000Z'
    });

    const stored = expectRpcResult(
      await doRpc<ControlPlaneDoResponse>(controlPlane, { type: 'control.api-key.get', apiKeyId: created.record.id }),
      'control.api-key.get.result'
    );
    expect(stored.record?.revokedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rejects revoking an unknown API key with a not-found contract error', async () => {
    const { env } = createTestEnv();
    const controlPlane = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await expect(doRpc<ControlPlaneDoResponse>(controlPlane, {
      type: 'control.api-key.revoke',
      apiKeyId: 'missing-key',
      revokedAt: '2026-10-01T00:00:00.000Z'
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404
    });
  });
});
