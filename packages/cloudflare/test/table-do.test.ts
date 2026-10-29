import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BadRequestError,
  type CreateTableInput,
  type ListRowsQuery,
  type ProjectDoResponse,
  type ResolvedTableConfigSnapshot,
  type TableDoRequest,
  type TableDoResponse
} from '@sheetflare/contracts';
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
  requestedRanges: string[];
};

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

function createSheetsFetch(sheet: SheetState) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

      if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
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

        sheet.requestedRanges.push(range);

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

    if (url.includes(':batchUpdate')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        requests?: Array<{ deleteDimension?: { range?: { startIndex?: number; endIndex?: number } } }>;
      };
      const range = body.requests?.[0]?.deleteDimension?.range;
      if (range?.startIndex !== undefined && range.endIndex !== undefined) {
        sheet.rows.splice(range.startIndex, range.endIndex - range.startIndex);
      }
      return Response.json({});
    }

    const range = decodeRangeFromUrl(url);
    if (!range) {
      throw new Error(`Unexpected request: ${url}`);
    }

    sheet.requestedRanges.push(range);

    if (init?.method === 'PUT') {
      const rowNumber = Number(range.match(/!(?:[A-Z]+)?(\d+):/)?.[1]);
      const body = JSON.parse(String(init.body)) as { values: string[][] };
      sheet.rows[rowNumber - 1] = body.values[0] ?? [];
      return Response.json({});
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
      const updatedRange = appendRange
        ? `'Users'!${appendRange[1]}${rowNumber}:${appendRange[1]}${rowNumber}`
        : `'Users'!A${rowNumber}:B${rowNumber}`;
      return Response.json({
        updates: {
          updatedRange
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

    const boundedRectangleMatch = range.match(/^'Users'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (boundedRectangleMatch && boundedRectangleMatch[2] !== boundedRectangleMatch[4]) {
      const startColumnIndex = columnLettersToIndex(boundedRectangleMatch[1]);
      const endColumnIndex = columnLettersToIndex(boundedRectangleMatch[3]);
      return Response.json({
        values: sheet.rows
          .slice(Number(boundedRectangleMatch[2]) - 1, Number(boundedRectangleMatch[4]))
          .map((row) => row.slice(startColumnIndex, endColumnIndex + 1))
      });
    }

    const boundedSingleRowMatch = range.match(/^'Users'!A(\d+):([A-Z]+)\d+$/);
    if (boundedSingleRowMatch) {
      const rowIndex = Number(boundedSingleRowMatch[1]) - 1;
      const endColumnIndex = columnLettersToIndex(boundedSingleRowMatch[2]);
      return Response.json({
        values: [sheet.rows[rowIndex]?.slice(0, endColumnIndex + 1) ?? []]
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
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      secondary: {
        clientEmail: 'secondary@example.com',
        privateKey: testPrivateKey
      }
    }),
    ...overrides
  };

  const env = partialEnv as CloudflareEnv;
  env.CONTROL_PLANE_DO = createDurableObjectNamespace(env, ControlPlaneDO) as never;
  env.PROJECT_DO = createDurableObjectNamespace(env, ProjectDO) as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return env;
}

const usersTable = {
  projectSlug: 'demo',
  tableSlug: 'users'
};

type TableDoResult<TType extends TableDoResponse['type']> = Extract<TableDoResponse, { type: TType }>['result'];

function isTableDoResponse<TType extends TableDoResponse['type']>(
  response: TableDoResponse,
  type: TType
): response is Extract<TableDoResponse, { type: TType }> {
  return response.type === type;
}

function getUsersTableStub(env: CloudflareEnv) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users'));
}

async function callUsersTable<TType extends TableDoResponse['type']>(
  env: CloudflareEnv,
  body: TableDoRequest,
  expectedType: TType
): Promise<TableDoResult<TType>> {
  const response = await doRpc<TableDoResponse>(getUsersTableStub(env), body);
  if (!isTableDoResponse(response, expectedType)) {
    throw new Error(`Expected ${expectedType} but received ${response.type}.`);
  }

  return response.result;
}

async function createUsersTable(env: CloudflareEnv, input: Omit<CreateTableInput, 'tableSlug' | 'sheetTabName'>) {
  const projectStub = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));
  await doRpc<ProjectDoResponse>(projectStub, {
    type: 'project.create',
    allowExisting: true,
    input: {
      slug: 'demo',
      name: 'Demo',
      spreadsheetId: 'sheet-1'
    }
  });
  await doRpc<ProjectDoResponse>(projectStub, {
    type: 'project.table.create',
    allowExisting: true,
    projectSlug: 'demo',
    input: {
      tableSlug: 'users',
      sheetTabName: 'Users',
      ...input
    }
  });
}

function buildResolvedUsersConfig(overrides?: Partial<ResolvedTableConfigSnapshot>): ResolvedTableConfigSnapshot {
  return {
    projectSlug: 'demo',
    tableSlug: 'users',
    spreadsheetId: 'sheet-1',
    googleCredentialRef: 'default',
    sheetTabName: 'Users',
    idColumn: '_id',
    indexedFields: ['_id'],
    readOnlyFields: [],
    fieldRules: {},
    headerRow: 1,
    dataStartRow: 2,
    readEnabled: true,
    createEnabled: true,
    updateEnabled: true,
    deleteEnabled: true,
    cacheTtlSeconds: 3600,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...overrides
  };
}

function listUsers(env: CloudflareEnv, query: ListRowsQuery = {}) {
  return callUsersTable(env, { type: 'table.rows.list', ...usersTable, query }, 'table.rows.list.result');
}

async function getUsersCacheStatus(env: CloudflareEnv) {
  const result = await callUsersTable(env, { type: 'table.cache.get', ...usersTable }, 'table.cache.get.result');
  return result.data;
}

function createUser(env: CloudflareEnv, values: Record<string, string>) {
  return callUsersTable(env, { type: 'table.row.create', ...usersTable, input: { values } }, 'table.row.create.result');
}

function updateUser(env: CloudflareEnv, rowId: string, values: Record<string, string>) {
  return callUsersTable(env, { type: 'table.row.update', ...usersTable, rowId, input: { values } }, 'table.row.update.result');
}

function deleteUser(env: CloudflareEnv, rowId: string) {
  return callUsersTable(env, { type: 'table.row.delete', ...usersTable, rowId }, 'table.row.delete.result');
}

// The workspace TypeScript lib is ES2022, so Promise.withResolvers is not typed here.
function createSignal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

// Holds the next snapshot read back after Google has answered it, so a test can change the sheet
// or the table while the sync that issued the read is still in flight. The held snapshot predates
// everything the test does before calling release().
function createSnapshotGate(baseFetch: FetchHandler, snapshotRange: string) {
  const reached = createSignal();
  const released = createSignal();
  let armed = false;
  const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (armed && decodeRangeFromUrl(String(input)) === snapshotRange) {
      armed = false;
      const snapshot = await baseFetch(input, init);
      reached.resolve();
      await released.promise;
      return snapshot;
    }

    return baseFetch(input, init);
  };

  return {
    fetch: gatedFetch,
    arm: () => {
      armed = true;
    },
    reached: reached.promise,
    release: released.resolve
  };
}

describe('TableDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', createSheetsFetch({
      rows: [
        ['_id', 'name', 'email', 'status', 'derived', 'score', 'dueDate'],
        ['row-1', 'Ada', 'ada@example.com', 'active', 'computed', '5', '2026-04-26']
      ],
      requestedRanges: []
    }));
  });

  it('defaults project credentials to the shared default ref when omitted', async () => {
    const env = createTestEnv();

    const response = await doRpc<ProjectDoResponse>(
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

    expect((response as {
      type: 'project.create.result';
      result: { data: { project: { googleCredentialRef: string } }; created: boolean };
    }).result.data.project.googleCredentialRef).toBe('default');
  });

  it('rejects duplicate project creation unless allowExisting is set', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.create',
          input: {
            slug: 'demo',
            name: 'Demo Updated',
            spreadsheetId: 'sheet-2'
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'Project demo already exists.'
    });
  });

  it('allows explicit project upserts when allowExisting is set', async () => {
    const env = createTestEnv();

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

    const response = await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        allowExisting: true,
        input: {
          slug: 'demo',
          name: 'Demo Updated',
          spreadsheetId: 'sheet-2'
        }
      }
    );

    expect((response as {
      type: 'project.create.result';
      result: { data: { project: { name: string; spreadsheetId: string } }; created: boolean };
    }).result).toMatchObject({
      created: false,
      data: {
        project: {
          name: 'Demo Updated',
          spreadsheetId: 'sheet-2'
        }
      }
    });
  });

  it('allows table delete retries to repair the project registry after local metadata is already gone', async () => {
    const env = createTestEnv();
    const projectStub = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));
    const controlPlaneStub = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.create',
      input: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1'
      }
    });
    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.table.create',
      projectSlug: 'demo',
      input: {
        tableSlug: 'users',
        sheetTabName: 'Users'
      }
    });

    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.table.delete',
      projectSlug: 'demo',
      tableSlug: 'users'
    });
    const retriedDelete = await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.table.delete',
      projectSlug: 'demo',
      tableSlug: 'users'
    });
    const projects = await doRpc<ControlPlaneDoResponse>(controlPlaneStub, {
      type: 'control.projects.list'
    });

    expect((retriedDelete as {
      type: 'project.table.delete.result';
      result: { ok: true; deletedTable: string };
    }).result).toEqual({
      ok: true,
      deletedTable: 'users'
    });
    expect((projects as {
      type: 'control.projects.list.result';
      result: { data: Array<{ slug: string; tableCount: number }> };
    }).result.data).toEqual([
      expect.objectContaining({
        slug: 'demo',
        tableCount: 0
      })
    ]);
  });

  it('treats table delete for an already-deleted project as an idempotent cleanup request', async () => {
    const env = createTestEnv();
    const projectStub = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));

    const response = await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.table.delete',
      projectSlug: 'demo',
      tableSlug: 'users'
    });

    expect((response as {
      type: 'project.table.delete.result';
      result: { ok: true; deletedTable: string };
    }).result).toEqual({
      ok: true,
      deletedTable: 'users'
    });
  });

  it('allows project delete retries to repair the registry after local metadata is already gone', async () => {
    const env = createTestEnv();
    const projectStub = env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo'));
    const controlPlaneStub = env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));

    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.create',
      input: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1'
      }
    });
    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.table.create',
      projectSlug: 'demo',
      input: {
        tableSlug: 'users',
        sheetTabName: 'Users'
      }
    });

    await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.delete',
      projectSlug: 'demo'
    });
    const retriedDelete = await doRpc<ProjectDoResponse>(projectStub, {
      type: 'project.delete',
      projectSlug: 'demo'
    });
    const projects = await doRpc<ControlPlaneDoResponse>(controlPlaneStub, {
      type: 'control.projects.list'
    });

    expect((retriedDelete as {
      type: 'project.delete.result';
      result: { ok: true; deletedProject: string; deletedTables: string[] };
    }).result).toEqual({
      ok: true,
      deletedProject: 'demo',
      deletedTables: []
    });
    expect((projects as {
      type: 'control.projects.list.result';
      result: { data: Array<unknown> };
    }).result.data).toEqual([]);
  });

  it('rejects project creation when a named credential ref is missing', async () => {
    const env = createTestEnv();

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.create',
          input: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'missing'
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'NotFoundError',
      message: 'Google credential "missing" was not found.'
    });
  });

  it('rejects table listing when the parent project is missing', async () => {
    const env = createTestEnv();

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.list',
          projectSlug: 'demo'
        }
      )
    ).rejects.toMatchObject({
      name: 'NotFoundError',
      message: 'Project demo was not found.'
    });
  });

  it('rejects table creation when the configured tab fields do not exist in the detected headers', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users',
            idColumn: '_id',
            indexedFields: ['email', 'missing'],
            headerRow: 1,
            dataStartRow: 2,
            readEnabled: true,
            createEnabled: true,
            updateEnabled: true,
            deleteEnabled: true,
            cacheTtlSeconds: 15
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Indexed field missing is not present in the detected sheet headers.'
    });
  });

  it('rejects duplicate table creation unless allowExisting is set', async () => {
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users'
        }
      }
    );

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'Table demo/users already exists.'
    });
  });

  it('rejects table creation when the provided sheet gid does not match the discovered tab', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users',
            sheetGid: 999,
            idColumn: '_id',
            indexedFields: ['name'],
            headerRow: 1,
            dataStartRow: 2,
            readEnabled: true,
            createEnabled: true,
            updateEnabled: true,
            deleteEnabled: true,
            cacheTtlSeconds: 15
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Sheet GID 999 does not match tab Users in spreadsheet sheet-1.'
    });
  });

  it('inspects spreadsheet tabs through ProjectDO using live sheet metadata', async () => {
    const env = createTestEnv();

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

    const response = await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.spreadsheet.tab.inspect',
        projectSlug: 'demo',
        tab: 'Users',
        headerRow: 1
      }
    );

    expect((response as { type: 'project.spreadsheet.tab.inspect.result'; result: { data: { tab: { title: string; sheetGid: number }; headers: string[] } } }).result.data).toEqual({
      tab: {
        title: 'Users',
        sheetGid: 1
      },
      headerRow: 1,
      headers: ['_id', 'name', 'email', 'status', 'derived', 'score', 'dueDate']
    });
  });

  it('rejects table configs where data rows do not start after the header row', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users',
            headerRow: 2,
            dataStartRow: 2
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'dataStartRow must be greater than headerRow.'
    });
  });

  it('rejects table configs whose effective indexed field set exceeds the supported limit', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users',
            idColumn: '_managed_id',
            indexedFields: Array.from({ length: 32 }, (_, index) => `field_${index + 1}`)
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'A table may index at most 32 fields including the managed ID column.'
    });
  });

  it('normalizes configured field names before persisting table config', async () => {
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: ' secondary '
        }
      }
    );

    const response = await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          idColumn: ' _id ',
          indexedFields: [' email ', ' status ', 'status', '  '],
          readOnlyFields: [' derived ', 'derived', '  '],
          fieldRules: {
            ' email ': {
              required: true,
              unique: true,
              normalize: ['trim', 'lowercase', 'trim']
            },
            ' status ': {
              enum: [' active ', 'active', 'pending']
            }
          }
        }
      }
    );

    expect(response).toMatchObject({
      type: 'project.table.create.result',
      result: {
        data: {
          idColumn: '_id',
          indexedFields: ['_id', 'email', 'status'],
          readOnlyFields: ['derived'],
          fieldRules: {
            email: {
              required: true,
              unique: true,
              normalize: ['trim', 'lowercase']
            },
            status: {
              enum: ['active', 'pending']
            }
          }
        }
      }
    });

    const project = await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.get',
        projectSlug: 'demo'
      }
    );

    expect(project).toMatchObject({
      type: 'project.get.result',
      result: {
        project: {
          googleCredentialRef: 'secondary'
        }
      }
    });
  });

  it('rejects unique field rules when the field is not indexed', async () => {
    const env = createTestEnv();

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

    await expect(
      doRpc<ProjectDoResponse>(
        env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
        {
          type: 'project.table.create',
          projectSlug: 'demo',
          input: {
            tableSlug: 'users',
            sheetTabName: 'Users',
            fieldRules: {
              email: {
                unique: true
              }
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Unique field email must also be indexed.'
    });
  });

  it('re-resolves stale row numbers by ID before updating', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
        }
      }
    );

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          sheetGid: 1,
          indexedFields: ['name'],
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

    sheet.requestedRanges = [];

    sheet.rows = [
      ['_id', 'name'],
      ['row-2', 'Grace'],
      ['row-1', 'Ada']
    ];

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Ada Lovelace'
          }
        }
      }
    );

    const updated = response as {
      type: 'table.row.update.result';
      result: { data: { id: string; rowNumber: number; values: { name: string } } };
    };

    expect(updated.result.data.rowNumber).toBe(3);
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-2', 'Grace'],
      ['row-1', 'Ada Lovelace']
    ]);
    expect(sheet.requestedRanges).not.toContain("'Users'");
  });

  it('rolls back an appended create skeleton when the follow-up patch fails', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/values:batchUpdate')) {
        return new Response(JSON.stringify({
          error: {
            message: 'Backend error'
          }
        }), {
          status: 503,
          headers: {
            'content-type': 'application/json'
          }
        });
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['name']
        }
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              name: 'Ada'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      message: 'Google Sheets API is temporarily unavailable.'
    });

    expect(sheet.rows).toEqual([
      ['_id', 'name']
    ]);
  });

  it('rolls back a moved create skeleton by re-resolving the managed row id before delete', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let injectedConcurrentRow = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/values:batchUpdate')) {
        if (!injectedConcurrentRow) {
          sheet.rows.splice(1, 0, ['row-manual', 'Manual']);
          injectedConcurrentRow = true;
        }

        return new Response(JSON.stringify({
          error: {
            message: 'Backend error'
          }
        }), {
          status: 503,
          headers: {
            'content-type': 'application/json'
          }
        });
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['name']
        }
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              name: 'Ada'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      message: 'Google Sheets API is temporarily unavailable.'
    });

    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-manual', 'Manual']
    ]);
  });

  it('rejects create writes that target read-only columns', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'derived']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          readOnlyFields: ['derived']
        }
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              name: 'Ada',
              derived: 'manual'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload contains read-only columns.'
    });
  });

  it('rejects create writes that violate required, enum, and type field rules', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email', 'status', 'score', 'dueDate']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['email', 'status', 'score', 'dueDate'],
          fieldRules: {
            email: {
              required: true,
              unique: true,
              normalize: ['trim', 'lowercase']
            },
            status: {
              enum: ['pending', 'active']
            },
            score: {
              type: 'number'
            },
            dueDate: {
              type: 'date'
            }
          }
        }
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              email: '   ',
              status: 'disabled',
              score: '10',
              dueDate: '05/01/2026'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Table row failed validation.',
      details: {
        fieldErrors: [
          { field: 'email', code: 'REQUIRED' },
          { field: 'status', code: 'ENUM' },
          { field: 'dueDate', code: 'TYPE' }
        ]
      }
    });
  });

  it('normalizes unique fields before storing and rejects duplicate creates with a conflict', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email'],
        ['row-1', 'alice@example.com']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['email'],
          cacheTtlSeconds: 3600,
          fieldRules: {
            email: {
              required: true,
              unique: true,
              normalize: ['trim', 'lowercase']
            }
          }
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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              email: ' Alice@Example.com '
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'email must be unique.'
    });
  });

  it('normalizes constrained patch values before writing successful updates', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email'],
        ['row-1', 'alice@example.com']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['email'],
          cacheTtlSeconds: 3600,
          fieldRules: {
            email: {
              required: true,
              unique: true,
              normalize: ['trim', 'lowercase']
            }
          }
        }
      }
    );

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            email: ' Alice+Ops@Example.com '
          }
        }
      }
    );

    expect(sheet.rows[1]).toEqual(['row-1', 'alice+ops@example.com']);
  });

  it('preserves read-only columns during sparse updates', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'derived', 'status'],
        ['row-1', 'Ada', 'Ada (derived)', 'active']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          readOnlyFields: ['derived'],
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

    sheet.requestedRanges = [];

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Ada Lovelace',
            status: 'inactive'
          }
        }
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.update.result',
      result: {
        data: {
          values: {
            _id: 'row-1',
            name: 'Ada Lovelace',
            derived: 'Ada (derived)',
            status: 'inactive'
          }
        }
      }
    });
    expect(sheet.rows[1]).toEqual(['row-1', 'Ada Lovelace', 'Ada (derived)', 'inactive']);
    expect(sheet.requestedRanges).toContain("'Users'!B2:B2");
    expect(sheet.requestedRanges).toContain("'Users'!D2:D2");
    expect(sheet.requestedRanges).not.toContain("'Users'!C2:C2");
  });

  it('rejects updates that target read-only columns after key normalization', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'derived'],
        ['row-1', 'Ada', 'computed']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          readOnlyFields: ['derived'],
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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.update',
          projectSlug: 'demo',
          tableSlug: 'users',
          rowId: 'row-1',
          input: {
            values: {
              ' derived ': 'changed'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload contains read-only columns.'
    });

    expect(sheet.rows[1]).toEqual(['row-1', 'Ada', 'computed']);
  });

  it('rejects updates that target the managed id column', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.update',
          projectSlug: 'demo',
          tableSlug: 'users',
          rowId: 'row-1',
          input: {
            values: {
              _id: 'row-999',
              name: 'Ada Lovelace'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload cannot update managed row id column _id.'
    });

    expect(sheet.rows[1]).toEqual(['row-1', 'Ada']);
  });

  it('does not rescan cached rows just to refresh schema metadata on updates', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    const listCachedRowsSpy = vi.spyOn(
      TableDO.prototype as TableDO & { listCachedRows: () => unknown },
      'listCachedRows'
    );

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

    listCachedRowsSpy.mockClear();

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Ada Lovelace'
          }
        }
      }
    );

    expect(listCachedRowsSpy).not.toHaveBeenCalled();
  });

  it('rejects create-row requests when the managed id already exists', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              _id: 'row-1',
              name: 'Duplicate'
            }
          }
        }
      )
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('preserves non-string scalar managed ids on create instead of generating a replacement id', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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

    sheet.requestedRanges = [];

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.create',
        projectSlug: 'demo',
        tableSlug: 'users',
        input: {
          values: {
            _id: 42,
            name: 'Ada'
          }
        }
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.create.result',
      result: {
        data: {
          id: '42',
          values: {
            _id: '42',
            name: 'Ada'
          }
        }
      }
    });
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['42', 'Ada']
    ]);
    expect(sheet.requestedRanges.filter((range) => range === "'Users'!1:1")).toHaveLength(2);
  });

  it('rejects create writes with unknown columns instead of silently dropping them', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.create',
          projectSlug: 'demo',
          tableSlug: 'users',
          input: {
            values: {
              name: 'Ada',
              status: 'active'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload contains unknown columns.'
    });
  });

  it('rejects update writes with unknown columns instead of silently dropping them', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {}
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.update',
          projectSlug: 'demo',
          tableSlug: 'users',
          rowId: 'row-1',
          input: {
            values: {
              status: 'active'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload contains unknown columns.'
    });
  });

  it('re-reads live headers for updates even while the cache is still fresh', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    sheet.requestedRanges = [];
    sheet.rows = [
      ['_id', 'full_name'],
      ['row-1', 'Ada']
    ];

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.update',
          projectSlug: 'demo',
          tableSlug: 'users',
          rowId: 'row-1',
          input: {
            values: {
              name: 'Ada Lovelace'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Write payload contains unknown columns.'
    });

    expect(sheet.requestedRanges.filter((range) => range === "'Users'!1:1")).toHaveLength(1);
  });

  it('updates a cached row through the hinted row number without forcing a full-sheet resync', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    sheet.requestedRanges = [];

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Ada Lovelace'
          }
        }
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.update.result',
      result: {
        data: {
          rowNumber: 2
        }
      }
    });
    expect(sheet.requestedRanges).not.toContain("'Users'!A2:A");
    expect(sheet.requestedRanges.filter((range) => range === "'Users'!1:1")).toHaveLength(1);
    expect(sheet.requestedRanges).not.toContain("'Users'");
  });

  it('resolves uncached point reads through the narrow row-id lookup path', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          sheetGid: 1,
          indexedFields: ['name'],
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

    sheet.requestedRanges = [];
    sheet.rows.push(['row-2', 'Grace']);

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.get',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-2'
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.get.result',
      result: {
        data: {
          id: 'row-2',
          values: {
            name: 'Grace'
          }
        }
      }
    });
    expect(sheet.requestedRanges).not.toContain("'Users'");
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");
  });

  it('avoids a full-sheet resync for stale point reads when a narrow upstream lookup is sufficient', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          cacheTtlSeconds: 1
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

    sheet.requestedRanges = [];
    sheet.rows.push(['row-2', 'Grace']);
    vi.setSystemTime(new Date('2026-04-26T12:00:03.000Z'));

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.get',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-2'
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.get.result',
      result: {
        data: {
          id: 'row-2'
        }
      }
    });
    expect(sheet.requestedRanges).not.toContain("'Users'");
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");

    vi.useRealTimers();
  });

  it('repairs cached row numbers after delete without forcing a full-sheet sync', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace'],
        ['row-3', 'Linus']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          sheetGid: 1,
          indexedFields: ['name'],
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

    sheet.requestedRanges = [];

    const deleteResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.delete',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-2'
      }
    );

    expect(deleteResponse).toMatchObject({
      type: 'table.row.delete.result',
      result: {
        ok: true,
        deletedId: 'row-2'
      }
    });
    expect(sheet.requestedRanges).not.toContain("'Users'");
    expect(sheet.requestedRanges).not.toContain("'Users'!A2:A");
    expect(sheet.requestedRanges.filter((range) => range === "'Users'!1:1")).toHaveLength(1);

    const listed = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc'
        }
      }
    );

    expect(listed).toMatchObject({
      type: 'table.rows.list.result',
      result: {
        data: [
          {
            id: 'row-1',
            rowNumber: 2
          },
          {
            id: 'row-3',
            rowNumber: 3
          }
        ]
      }
    });
  });

  it('rebuilds cached indexes when table config changes', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'status'],
        ['row-1', 'Ada', 'active'],
        ['row-2', 'Grace', 'inactive']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          indexedFields: ['name'],
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

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['name', 'status'],
          cacheTtlSeconds: 3600
        }
      }
    );

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: { data: { stale: boolean } };
    }).result.data.stale).toBe(true);

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          filter: {
            status: {
              eq: 'active'
            }
          }
        }
      }
    );

    const listed = response as {
      type: 'table.rows.list.result';
      result: { data: Array<{ id: string }> };
    };

    expect(listed.result.data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('keeps cache metadata stale after a config-driven resync fails', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'status'],
        ['row-1', 'Ada', 'active'],
        ['row-2', 'Grace', 'inactive']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          indexedFields: ['name'],
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

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.table.create',
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['name', 'status'],
          cacheTtlSeconds: 3600
        }
      }
    );

    sheet.rows = [
      ['_id', 'name', 'name'],
      ['row-1', 'Ada', 'Duplicate'],
      ['row-2', 'Grace', 'Again']
    ];

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.rows.list',
          projectSlug: 'demo',
          tableSlug: 'users',
          query: {
            filter: {
              status: {
                eq: 'active'
              }
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate header "name" was found in the configured sheet header row.'
    });

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: {
        data: {
          status: string;
          stale: boolean;
        };
      };
    }).result.data).toMatchObject({
      status: 'error',
      stale: true
    });
  });

  it('returns cached status without a resync when refresh-if-stale is called on a fresh cache', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          indexedFields: ['name'],
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

    const requestedRangeCountBeforeRefresh = sheet.requestedRanges.length;
    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.refresh',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((response as {
      type: 'table.cache.refresh.result';
      result: { rowCount: number; cache: { staleReason: string } };
    }).result).toMatchObject({
      rowCount: 1,
      cache: {
        staleReason: 'fresh'
      }
    });
    expect(sheet.requestedRanges.length).toBe(requestedRangeCountBeforeRefresh);
  });

  it('surfaces sync-time field-rule drift in cache status without failing the sync', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email'],
        ['row-1', 'Ada@Example.com'],
        ['row-2', 'ada@example.com']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['email'],
          fieldRules: {
            email: {
              unique: true,
              normalize: ['trim', 'lowercase']
            }
          }
        }
      }
    );

    const listResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {}
      }
    );

    expect((listResponse as {
      type: 'table.rows.list.result';
      result: { data: Array<{ id: string }> };
    }).result.data).toHaveLength(2);

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: {
        data: {
          status: string;
          validation: {
            status: string;
            issueCount: number;
            issues: Array<{ field: string; code: string; rowId: string }>;
          };
        };
      };
    }).result.data).toMatchObject({
      status: 'ready',
      validation: {
        status: 'warning',
        issueCount: 1
      }
    });
    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: {
        data: {
          validation: {
            issues: Array<{ field: string; code: string; rowId: string }>;
          };
        };
      };
    }).result.data.validation.issues[0]).toMatchObject({
      field: 'email',
      code: 'UNIQUE',
      rowId: 'row-2'
    });
  });

  it('refreshes validation status after an API mutation fixes previously drifted rows', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email'],
        ['row-1', 'Ada@Example.com'],
        ['row-2', 'ada@example.com']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
        allowExisting: true,
        projectSlug: 'demo',
        input: {
          tableSlug: 'users',
          sheetTabName: 'Users',
          indexedFields: ['email'],
          fieldRules: {
            email: {
              unique: true,
              normalize: ['trim', 'lowercase']
            }
          }
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

    const cacheStatusBeforeFix = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatusBeforeFix as {
      type: 'table.cache.get.result';
      result: { data: { validation: { status: string; issueCount: number } } };
    }).result.data.validation).toMatchObject({
      status: 'warning',
      issueCount: 1
    });

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-2',
        input: {
          values: {
            email: 'ada+2@example.com'
          }
        }
      }
    );

    const cacheStatusAfterFix = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatusAfterFix as {
      type: 'table.cache.get.result';
      result: {
        data: {
          validation: {
            status: string;
            issueCount: number;
            issues: unknown[];
          };
        };
      };
    }).result.data.validation).toMatchObject({
      status: 'warning',
      issueCount: 1
    });
  });

  it('keeps sync completion logs bound to the request context that started the sync', async () => {
    let releaseSync: (() => void) | null = null;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));

      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({
          access_token: 'token',
          expires_in: 3600
        });
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

      if (url.includes("/values/'Users'!1:1")) {
        return Response.json({
          values: [['_id', 'name']]
        });
      }

      if (url.includes("/values/'Users'!A1:B")) {
        await syncGate;
        return Response.json({
          values: [
            ['_id', 'name'],
            ['row-1', 'Ada']
          ]
        });
      }

      if (url.includes(':append') || url.includes('/values:batchUpdate') || url.includes(':batchUpdate')) {
        return Response.json({});
      }

      if (url.includes("/values/'Users'!A2:B2")) {
        return Response.json({
          values: [['row-1', 'Ada']]
        });
      }

      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });

    const env = createTestEnv();

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

    const listPromise = doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {},
        requestContext: {
          requestId: 'req-sync-starter',
          route: 'rows.list',
          principal: 'principal-a'
        }
      }
    );

    await Promise.resolve();

    const cachePromise = doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users',
        requestContext: {
          requestId: 'req-later',
          route: 'table.cache.get',
          principal: 'principal-b'
        }
      }
    );

    releaseSync?.();
    await Promise.all([listPromise, cachePromise]);

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"requestId":"req-sync-starter"'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"principal":"principal-a"'));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('"requestId":"req-later"'));
  });

  it('rebuilds the cache when refresh-if-stale is called after ttl expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          indexedFields: ['name'],
          cacheTtlSeconds: 0
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

    sheet.rows = [
      ['_id', 'name'],
      ['row-1', 'Ada'],
      ['row-2', 'Grace']
    ];
    vi.setSystemTime(new Date('2026-04-26T12:00:01.000Z'));

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.refresh',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((response as {
      type: 'table.cache.refresh.result';
      result: { rowCount: number; cache: { rowCount: number; lastSyncCompletedAt: string | null } };
    }).result).toMatchObject({
      rowCount: 2,
      cache: {
        rowCount: 2
      }
    });
    expect((response as {
      type: 'table.cache.refresh.result';
      result: { cache: { lastSyncCompletedAt: string | null } };
    }).result.cache.lastSyncCompletedAt).not.toBeNull();

    vi.useRealTimers();
  });

  it('fails hard when duplicate managed IDs are detected upstream', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-1', 'Grace']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.rows.list',
          projectSlug: 'demo',
          tableSlug: 'users',
          query: {}
        }
      )
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects updates when a cached row id has become duplicated upstream and a change was signaled', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          sheetGid: 1,
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

    sheet.rows = [
      ['_id', 'name'],
      ['row-1', 'Ada'],
      ['row-1', 'Duplicate']
    ];
    await callUsersTable(env, {
      type: 'table.external-change.record',
      ...usersTable,
      changedAt: '2026-10-28T00:00:00.000Z',
      debounceUntil: null
    }, 'table.external-change.record.result');

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.row.update',
          projectSlug: 'demo',
          tableSlug: 'users',
          rowId: 'row-1',
          input: {
            values: {
              name: 'Ada Lovelace'
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate managed row id detected for row-1.'
    });
  });

  it('avoids a full-sheet resync for stale updates when a narrow row-id repair is sufficient', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          sheetGid: 1,
          indexedFields: ['name'],
          cacheTtlSeconds: 1
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

    sheet.requestedRanges = [];
    sheet.rows = [
      ['_id', 'name'],
      ['row-2', 'Grace'],
      ['row-1', 'Ada']
    ];
    vi.setSystemTime(new Date('2026-04-26T12:00:03.000Z'));

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Ada Lovelace'
          }
        }
      }
    );

    expect(response).toMatchObject({
      type: 'table.row.update.result',
      result: {
        data: {
          rowNumber: 3
        }
      }
    });
    expect(sheet.requestedRanges).not.toContain("'Users'");
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");

    vi.useRealTimers();
  });

  it('includes header-defined fields in schema output even when rows are empty or sparse', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'status', 'notes'],
        ['row-1', 'Ada', 'active', ''],
        ['row-2', 'Grace', '', '']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.schema.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect(response).toMatchObject({
      type: 'table.schema.get.result',
      result: {
        data: {
          fields: [
            { name: '_id', inferredType: 'string', nullable: false },
            { name: 'name', inferredType: 'string', nullable: false },
            { name: 'notes', inferredType: 'unknown', nullable: true },
            { name: 'status', inferredType: 'string', nullable: true }
          ]
        }
      }
    });
  });

  it('recomputes schema lazily from cached rows after a write invalidates schema metadata', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', '']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          indexedFields: ['status'],
          cacheTtlSeconds: 3600
        }
      }
    );

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.schema.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.create',
        projectSlug: 'demo',
        tableSlug: 'users',
        input: {
          values: {
            status: 'active'
          }
        }
      }
    );

    sheet.requestedRanges = [];

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.schema.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect(response).toMatchObject({
      type: 'table.schema.get.result',
      result: {
        data: {
          fields: [
            { name: '_id', inferredType: 'string', nullable: false },
            { name: 'status', inferredType: 'string', nullable: true }
          ]
        }
      }
    });
    expect(sheet.requestedRanges).toEqual([]);
  });

  it('preserves last full sync timestamps after a successful mutation updates the cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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
          indexedFields: ['status'],
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

    const cacheStatusBeforeMutation = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    vi.setSystemTime(new Date('2026-04-26T12:10:00.000Z'));

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            status: 'active'
          }
        }
      }
    );

    const cacheStatusAfterMutation = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatusBeforeMutation as {
      type: 'table.cache.get.result';
      result: {
        data: {
          lastSyncStartedAt: string | null;
          lastSyncCompletedAt: string | null;
          validation: { validatedAt: string | null };
        };
      };
    }).result.data).toMatchObject({
      lastSyncStartedAt: '2026-04-26T12:00:00.000Z',
      lastSyncCompletedAt: '2026-04-26T12:00:00.000Z',
      validation: {
        validatedAt: '2026-04-26T12:00:00.000Z'
      }
    });
    expect((cacheStatusAfterMutation as {
      type: 'table.cache.get.result';
      result: {
        data: {
          lastSyncStartedAt: string | null;
          lastSyncCompletedAt: string | null;
          stale: boolean;
          rowCount: number;
          validation: { validatedAt: string | null };
        };
      };
    }).result.data).toMatchObject({
      lastSyncStartedAt: '2026-04-26T12:00:00.000Z',
      lastSyncCompletedAt: '2026-04-26T12:10:00.000Z',
      stale: false,
      rowCount: 1,
      validation: {
        validatedAt: '2026-04-26T12:00:00.000Z'
      }
    });

    vi.useRealTimers();
  });

  it('surfaces pending external sheet changes without forcing cached point reads to reindex immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:00:10.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.external-change.record',
        projectSlug: 'demo',
        tableSlug: 'users',
        changedAt: '2026-04-29T12:00:00.000Z',
        debounceUntil: '2026-04-29T12:00:30.000Z'
      }
    );

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: {
        data: {
          staleReason: string;
          externalChange: {
            pending: boolean;
            lastChangedAt: string | null;
            debounceUntil: string | null;
            lastAutoReindexAt: string | null;
          };
        };
      };
    }).result.data).toMatchObject({
      staleReason: 'external-change',
      externalChange: {
        pending: true,
        lastChangedAt: '2026-04-29T12:00:00.000Z',
        debounceUntil: '2026-04-29T12:00:30.000Z',
        lastAutoReindexAt: null
      }
    });

    sheet.requestedRanges = [];

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
      result: { data: { id: string; values: { name: string } } };
    }).result.data).toMatchObject({
      id: 'row-1',
      values: {
        name: 'Ada'
      }
    });
    expect(sheet.requestedRanges).toEqual([]);

    vi.useRealTimers();
  });

  it('forces a full sync before mutations when an external sheet change is pending', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'review']
    ];

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.external-change.record',
        projectSlug: 'demo',
        tableSlug: 'users',
        changedAt: '2026-04-29T12:05:00.000Z',
        debounceUntil: '2026-04-29T12:05:30.000Z'
      }
    );

    sheet.requestedRanges = [];

    const updateResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            status: 'approved'
          }
        }
      }
    );

    expect((updateResponse as {
      type: 'table.row.update.result';
      result: { data: { values: { status: string } } };
    }).result.data.values.status).toBe('approved');
    expect(sheet.requestedRanges).toContain("'Users'!A1:B");

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: { data: { staleReason: string; externalChange: { pending: boolean } } };
    }).result.data).toMatchObject({
      staleReason: 'fresh',
      externalChange: {
        pending: false
      }
    });
  });

  it('forces a full sync on reads once an external-change debounce window has already elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:20:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'active']
    ];

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.external-change.record',
        projectSlug: 'demo',
        tableSlug: 'users',
        changedAt: '2026-04-29T12:20:05.000Z',
        debounceUntil: '2026-04-29T12:20:10.000Z'
      }
    );

    vi.setSystemTime(new Date('2026-04-29T12:20:11.000Z'));
    sheet.requestedRanges = [];

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
    expect(sheet.requestedRanges).toContain("'Users'!A1:B");

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: { data: { staleReason: string; externalChange: { pending: boolean } } };
    }).result.data).toMatchObject({
      staleReason: 'fresh',
      externalChange: {
        pending: false
      }
    });

    vi.useRealTimers();
  });

  it('records the last automatic external-change reindex time after a Drive-triggered sync', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T12:10:00.000Z'));

    const sheet: SheetState = {
      rows: [
        ['_id', 'status'],
        ['row-1', 'draft']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.external-change.record',
        projectSlug: 'demo',
        tableSlug: 'users',
        changedAt: '2026-04-29T12:11:00.000Z',
        debounceUntil: '2026-04-29T12:11:30.000Z'
      }
    );

    vi.setSystemTime(new Date('2026-04-29T12:12:00.000Z'));
    sheet.rows = [
      ['_id', 'status'],
      ['row-1', 'active']
    ];

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.reindex',
        projectSlug: 'demo',
        tableSlug: 'users',
        requestContext: {
          requestId: 'req-auto',
          route: '/system/google/drive/notifications',
          principal: 'system:drive-watch',
          syncSource: 'external-change'
        }
      }
    );

    const cacheStatus = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.cache.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect((cacheStatus as {
      type: 'table.cache.get.result';
      result: {
        data: {
          staleReason: string;
          externalChange: {
            pending: boolean;
            lastChangedAt: string | null;
            debounceUntil: string | null;
            lastAutoReindexAt: string | null;
          };
        };
      };
    }).result.data).toMatchObject({
      staleReason: 'fresh',
      externalChange: {
        pending: false,
        lastChangedAt: '2026-04-29T12:11:00.000Z',
        debounceUntil: null,
        lastAutoReindexAt: '2026-04-29T12:12:00.000Z'
      }
    });

    vi.useRealTimers();
  });

  it('builds schema metadata from the full cached dataset instead of a 100-row sample', async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      index === 100
        ? ['row-101', '101']
        : [`row-${index + 1}`, '']
    );
    const sheet: SheetState = {
      rows: [
        ['_id', 'score'],
        ...rows
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.schema.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect(response).toMatchObject({
      type: 'table.schema.get.result',
      result: {
        data: {
          fields: [
            { name: '_id', inferredType: 'string', nullable: false },
            { name: 'score', inferredType: 'string', nullable: true }
          ]
        }
      }
    });
  });

  it('fails list syncs when a managed row id is blank', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.rows.list',
          projectSlug: 'demo',
          tableSlug: 'users',
          query: {}
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Blank managed row id detected in column _id at row 2.'
    });
  });

  it('rejects scan-based pagination cursors once the cursor row disappears between pages', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

    await doRpc<ProjectDoResponse>(
      env.PROJECT_DO.get(env.PROJECT_DO.idFromName('project:demo')),
      {
        type: 'project.create',
        input: {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'secondary'
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
          indexedFields: ['name'],
          cacheTtlSeconds: 3600
        }
      }
    );

    const firstPage = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          limit: 2,
          sort: 'name:asc',
          filter: {
            name: {
              contains: 'a'
            }
          }
        }
      }
    );

    const firstResult = firstPage as {
      type: 'table.rows.list.result';
      result: {
        data: Array<{ id: string }>;
        nextCursor: string | null;
      };
    };

    expect(firstResult.result.data.map((row) => row.id)).toEqual(['row-1', 'row-2']);
    expect(firstResult.result.nextCursor).toBeTruthy();

    sheet.rows = [
      ['_id', 'name'],
      ['row-1', 'Ada'],
      ['row-3', 'Cora']
    ];

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.reindex',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    await expect(listUsers(env, {
      limit: 2,
      sort: 'name:asc',
      filter: {
        name: {
          contains: 'a'
        }
      },
      cursor: firstResult.result.nextCursor
    })).rejects.toMatchObject({
      name: 'BadRequestError',
      details: { reason: 'stale-cursor' }
    });

    const restarted = await listUsers(env, {
      limit: 2,
      sort: 'name:asc',
      filter: {
        name: {
          contains: 'a'
        }
      }
    });
    expect(restarted.data.map((row) => row.id)).toEqual(['row-1', 'row-3']);
    expect(restarted.nextCursor).toBeNull();
  });

  it('rejects list projections that request unknown fields', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();

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

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.rows.list',
          projectSlug: 'demo',
          tableSlug: 'users',
          query: {
            fields: ['name', 'status']
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'fields contains unknown columns.'
    });
  });

  it('treats startsWith and contains as literal string operators', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'a_1'],
        ['row-2', 'ab1'],
        ['row-3', 'x%z'],
        ['row-4', 'axz']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['name'],
          cacheTtlSeconds: 3600
        }
      }
    );

    const startsWithResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          filter: {
            name: {
              startsWith: 'a_'
            }
          }
        }
      }
    );

    const containsResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          filter: {
            name: {
              contains: '%'
            }
          }
        }
      }
    );

    expect((startsWithResponse as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-1']);
    expect((containsResponse as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-3']);
  });

  it('binds multiple indexed filter parameters in SQL placeholder order', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'email', 'status', 'name'],
        ['row-1', 'ada@example.com', 'active', 'Ada'],
        ['row-2', 'ada@example.com', 'inactive', 'Ada Old'],
        ['row-3', 'grace@example.com', 'active', 'Grace']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['email', 'status', 'name'],
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc',
          filter: {
            email: {
              eq: 'ada@example.com'
            },
            status: {
              eq: 'active'
            }
          }
        }
      }
    );

    expect((response as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('binds indexed sort parameters before indexed filter condition parameters', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'status', 'name'],
        ['row-1', 'active', 'Zoe'],
        ['row-2', 'inactive', 'Ada'],
        ['row-3', 'active', 'Bea']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['status', 'name'],
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'name:asc',
          filter: {
            status: {
              eq: 'active'
            }
          }
        }
      }
    );

    expect((response as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-3', 'row-1']);
  });

  it('treats SQL-shaped indexed field names and filter values as bound values', async () => {
    const env = createTestEnv();
    const suspiciousFieldName = "status') OR 1=1 --";
    const suspiciousValue = "active' OR '1'='1";
    const sheet: SheetState = {
      rows: [
        ['_id', suspiciousFieldName],
        ['row-1', 'active'],
        ['row-2', suspiciousValue],
        ['row-3', 'inactive']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: [suspiciousFieldName],
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc',
          filter: {
            [suspiciousFieldName]: {
              eq: suspiciousValue
            }
          }
        }
      }
    );

    expect((response as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-2']);
  });

  it('applies indexed neq filters consistently across null and mismatched kinds', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'score'],
        ['row-1', '10'],
        ['row-2', '11'],
        ['row-3', ''],
        ['row-4', 'ten']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['score'],
          fieldRules: {
            score: {
              type: 'number'
            }
          },
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc',
          filter: {
            score: {
              neq: 10
            }
          }
        }
      }
    );

    expect((response as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-2', 'row-3', 'row-4']);
  });

  it('does not rebuild the full validation summary again after a successful mutation', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const validationSpy = vi.spyOn(
      TableDO.prototype as {
        buildValidationSummary: (rows: readonly unknown[], config: unknown) => unknown;
      },
      'buildValidationSummary'
    );

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
          fieldRules: {
            name: {
              required: true
            }
          },
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.update',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1',
        input: {
          values: {
            name: 'Adele'
          }
        }
      }
    );

    expect((response as {
      type: 'table.row.update.result';
      result: { data: { values: { name: string } } };
    }).result.data.values.name).toBe('Adele');
    expect(validationSpy).toHaveBeenCalledTimes(1);
    validationSpy.mockRestore();
  });

  it('round-trips typed numeric field values through indexed string filters', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'score'],
        ['row-1', '10'],
        ['row-2', '11'],
        ['row-3', '']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['score'],
          fieldRules: {
            score: {
              type: 'number'
            }
          },
          cacheTtlSeconds: 3600
        }
      }
    );

    const allRowsResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc'
        }
      }
    );

    const returnedScore = (allRowsResponse as {
      type: 'table.rows.list.result';
      result: { data: Array<{ values: { score: string | null } }> };
    }).result.data[0]?.values.score;

    expect(returnedScore).toBe('10');

    const filteredResponse = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc',
          filter: {
            score: {
              eq: returnedScore
            }
          }
        }
      }
    );

    expect((filteredResponse as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('applies typed string filters consistently when another predicate forces a full scan', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'score'],
        ['row-1', 'Ada', '10'],
        ['row-2', 'Grace', '11'],
        ['row-3', 'Bob', '10']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['name', 'score'],
          fieldRules: {
            score: {
              type: 'number'
            }
          },
          cacheTtlSeconds: 3600
        }
      }
    );

    const response = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.rows.list',
        projectSlug: 'demo',
        tableSlug: 'users',
        query: {
          sort: 'rowNumber:asc',
          filter: {
            name: {
              contains: 'a'
            },
            score: {
              eq: '10'
            }
          }
        }
      }
    );

    expect((response as { type: 'table.rows.list.result'; result: { data: Array<{ id: string }> } }).result.data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('uses the configured full-scan threshold override when rejecting scan-heavy queries', async () => {
    const env = createTestEnv({
      TABLE_MAX_FULL_SCAN_ROWS: '2'
    });
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          indexedFields: ['name'],
          cacheTtlSeconds: 3600
        }
      }
    );

    await expect(
      doRpc<TableDoResponse>(
        env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
        {
          type: 'table.rows.list',
          projectSlug: 'demo',
          tableSlug: 'users',
          query: {
            filter: {
              name: {
                contains: 'a'
              }
            }
          }
        }
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'This query requires a full scan and exceeds the configured scan threshold of 2 cached rows.'
    });
  });

  it('refreshes cached headers after delete when the sheet layout changes manually', async () => {
    const env = createTestEnv();
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Grace']
      ],
      requestedRanges: []
    };

    vi.stubGlobal('fetch', createSheetsFetch(sheet));

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
          sheetGid: 1,
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

    sheet.rows = [
      ['_id', 'name', 'status'],
      ['row-1', 'Ada', 'active'],
      ['row-2', 'Grace', 'inactive']
    ];

    await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.row.delete',
        projectSlug: 'demo',
        tableSlug: 'users',
        rowId: 'row-1'
      }
    );

    const schema = await doRpc<TableDoResponse>(
      env.TABLE_DO.get(env.TABLE_DO.idFromName('table:demo:users')),
      {
        type: 'table.schema.get',
        projectSlug: 'demo',
        tableSlug: 'users'
      }
    );

    expect(schema).toMatchObject({
      type: 'table.schema.get.result',
      result: {
        data: {
          fields: [
            { name: '_id', inferredType: 'string', nullable: false },
            { name: 'name', inferredType: 'string', nullable: false },
            { name: 'status', inferredType: 'string', nullable: false }
          ]
        }
      }
    });
  });

  it('rejects resolved table configs whose cache TTL exceeds one hour', async () => {
    const env = createTestEnv();

    await expect(
      callUsersTable(
        env,
        { type: 'table.cache.get', ...usersTable, resolvedConfig: buildResolvedUsersConfig({ cacheTtlSeconds: 3601 }) },
        'table.cache.get.result'
      )
    ).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Request validation failed.'
    });

    await expect(
      callUsersTable(
        env,
        { type: 'table.cache.get', ...usersTable, resolvedConfig: buildResolvedUsersConfig({ cacheTtlSeconds: 3600 }) },
        'table.cache.get.result'
      )
    ).resolves.toMatchObject({
      data: {
        cacheTtlSeconds: 3600
      }
    });
  });

  it('rejects creates and updates whose date or datetime values are impossible calendar values', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'dueDate', 'updatedAt'],
        ['row-1', '2026-02-28', '2026-02-28T10:00:00Z']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, {
      fieldRules: {
        dueDate: { type: 'date' },
        updatedAt: { type: 'datetime' }
      },
      cacheTtlSeconds: 3600
    });

    await expect(createUser(env, { dueDate: '2026-02-30', updatedAt: '2026-02-30T10:00:00Z' })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Table row failed validation.',
      details: {
        fieldErrors: [
          { field: 'dueDate', code: 'TYPE' },
          { field: 'updatedAt', code: 'TYPE' }
        ]
      }
    });
    await expect(updateUser(env, 'row-1', { updatedAt: '2026-04-26T24:00:00Z' })).rejects.toMatchObject({
      name: 'BadRequestError',
      details: {
        fieldErrors: [{ field: 'updatedAt', code: 'TYPE' }]
      }
    });
    expect(sheet.rows).toEqual([
      ['_id', 'dueDate', 'updatedAt'],
      ['row-1', '2026-02-28', '2026-02-28T10:00:00Z']
    ]);
  });

  it('never returns raw Google error text in TableDO error responses or cache status', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sentinel = 'SENSITIVE_UPSTREAM_TEXT project 123456789012';
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let rejectReads = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (rejectReads && String(input).includes('/values/')) {
        return Response.json({ error: { code: 403, message: sentinel, status: 'PERMISSION_DENIED' } }, { status: 403 });
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    rejectReads = true;

    const response = await getUsersTableStub(env).fetch('https://do.internal/rpc', {
      method: 'POST',
      body: JSON.stringify({ type: 'table.rows.list', ...usersTable, query: {} })
    });
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain('SENSITIVE_UPSTREAM_TEXT');
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'BAD_GATEWAY',
        message: 'Google Sheets authentication or permission check failed.',
        details: { status: 403, googleStatus: 'PERMISSION_DENIED' }
      }
    });
    expect(JSON.stringify(await getUsersCacheStatus(env))).not.toContain('SENSITIVE_UPSTREAM_TEXT');
  });

  it('treats startsWith as a case-sensitive, scan-heavy operator on indexed fields', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Apple'],
        ['row-2', 'apricot'],
        ['row-3', 'banana']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 3600 });

    const result = await listUsers(env, { filter: { name: { startsWith: 'a' } } });
    expect(result.data.map((row) => row.id)).toEqual(['row-2']);

    const limitedEnv = createTestEnv({ TABLE_MAX_FULL_SCAN_ROWS: '2' });
    await createUsersTable(limitedEnv, { indexedFields: ['name'], cacheTtlSeconds: 3600 });
    await expect(listUsers(limitedEnv, { filter: { name: { startsWith: 'A' } } })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'This query requires a full scan and exceeds the configured scan threshold of 2 cached rows.'
    });
  });

  it('applies rowNumber filters identically on indexed and scan paths', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 3600 });

    const indexed = await listUsers(env, { filter: { rowNumber: { eq: '3' } } });
    const scanned = await listUsers(env, { filter: { rowNumber: { eq: '3' }, name: { contains: 'a' } } });
    const rangedScan = await listUsers(env, { filter: { rowNumber: { gte: '3' }, name: { contains: 'a' } } });

    expect(indexed.data.map((row) => row.id)).toEqual(['row-2']);
    expect(scanned.data.map((row) => row.id)).toEqual(['row-2']);
    expect(rangedScan.data.map((row) => row.id)).toEqual(['row-2', 'row-3']);
    await expect(listUsers(env, { filter: { rowNumber: { contains: '2' } } })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'rowNumber filters do not support startsWith or contains.'
    });
    await expect(listUsers(env, { filter: { rowNumber: { eq: 'two' } } })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'rowNumber filters require numeric values.'
    });
  });

  it('applies id filters identically on indexed and scan paths, including numeric and boolean operands', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['5', 'Ada'],
        ['6', 'Bea'],
        ['10', 'Cora'],
        ['true', 'Dora']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 3600 });

    // Every name contains "a", so the second query is identical except that it must run as a scan.
    const idsOnBothPaths = async (filter: NonNullable<ListRowsQuery['filter']>) => {
      const indexed = await listUsers(env, { filter });
      const scanned = await listUsers(env, { filter: { ...filter, name: { contains: 'a' } } });
      return { indexed: indexed.data.map((row) => row.id), scanned: scanned.data.map((row) => row.id) };
    };

    await expect(idsOnBothPaths({ id: { eq: 5 } })).resolves.toEqual({ indexed: ['5'], scanned: ['5'] });
    await expect(idsOnBothPaths({ id: { eq: '5' } })).resolves.toEqual({ indexed: ['5'], scanned: ['5'] });
    await expect(idsOnBothPaths({ id: { neq: 5 } })).resolves.toEqual({ indexed: ['6', '10', 'true'], scanned: ['6', '10', 'true'] });
    await expect(idsOnBothPaths({ id: { in: [5, '6', false] } })).resolves.toEqual({ indexed: ['5', '6'], scanned: ['5', '6'] });
    await expect(idsOnBothPaths({ id: { eq: true } })).resolves.toEqual({ indexed: ['true'], scanned: ['true'] });
    // Range operators compare IDs as text on both paths: '10' sorts before '5'.
    await expect(idsOnBothPaths({ id: { gt: 5 } })).resolves.toEqual({ indexed: ['6', 'true'], scanned: ['6', 'true'] });
    await expect(idsOnBothPaths({ id: { gte: 10, lt: 6 } })).resolves.toEqual({ indexed: ['5', '10'], scanned: ['5', '10'] });
    await expect(idsOnBothPaths({ id: { eq: "5' OR '1'='1" } })).resolves.toEqual({ indexed: [], scanned: [] });
  });

  it('compares unique and filtered values through the field normalization rules', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'email'],
        ['row-1', 'Alice@Example.com ']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, {
      indexedFields: ['email'],
      fieldRules: {
        email: {
          unique: true,
          normalize: ['trim', 'lowercase']
        }
      },
      cacheTtlSeconds: 3600
    });
    await listUsers(env);

    await expect(createUser(env, { email: ' alice@example.com ' })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'email must be unique.',
      details: {
        field: 'email',
        value: 'alice@example.com',
        conflictingRowIds: ['row-1']
      }
    });
    expect(sheet.rows).toEqual([
      ['_id', 'email'],
      ['row-1', 'Alice@Example.com ']
    ]);

    const indexed = await listUsers(env, { filter: { email: { eq: 'ALICE@example.com' } } });
    const scanned = await listUsers(env, { filter: { email: { eq: 'ALICE@example.com' }, _id: { contains: 'row' } } });
    expect(indexed.data.map((row) => row.id)).toEqual(['row-1']);
    expect(scanned.data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('reports a cheap, monotonic data generation that advances whenever reads could change', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let googleRequestCount = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      googleRequestCount += 1;
      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 3600 });
    const getGeneration = () => callUsersTable(env, { type: 'table.generation.get', ...usersTable }, 'table.generation.get.result');

    let requestsBefore = googleRequestCount;
    const initial = await getGeneration();
    expect(googleRequestCount).toBe(requestsBefore);
    expect(initial).toEqual({ dataGeneration: 0, lastSyncCompletedAt: null, cacheTtlSeconds: 3600 });

    let lastGeneration = initial.dataGeneration;
    const expectGenerationAdvanced = async () => {
      const next = await getGeneration();
      expect(next.dataGeneration).toBeGreaterThan(lastGeneration);
      lastGeneration = next.dataGeneration;
      return next;
    };

    await listUsers(env);
    const afterSync = await expectGenerationAdvanced();
    expect(afterSync.lastSyncCompletedAt).not.toBeNull();
    expect((await getUsersCacheStatus(env)).dataGeneration).toBe(lastGeneration);

    const created = await createUser(env, { name: 'Grace' });
    await expectGenerationAdvanced();
    await updateUser(env, 'row-1', { name: 'Ada Lovelace' });
    await expectGenerationAdvanced();
    await deleteUser(env, created.data.id);
    await expectGenerationAdvanced();

    await callUsersTable(env, {
      type: 'table.external-change.record',
      ...usersTable,
      changedAt: '2026-10-28T00:00:00.000Z',
      debounceUntil: null
    }, 'table.external-change.record.result');
    await expectGenerationAdvanced();
    await callUsersTable(env, { type: 'table.reindex', ...usersTable }, 'table.reindex.result');
    await expectGenerationAdvanced();

    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 60 });
    const afterConfigChange = await expectGenerationAdvanced();
    expect(afterConfigChange.cacheTtlSeconds).toBe(60);

    await callUsersTable(env, { type: 'table.cache.clear', ...usersTable }, 'table.cache.clear.result');
    const afterClear = await expectGenerationAdvanced();
    expect(afterClear.lastSyncCompletedAt).toBeNull();

    requestsBefore = googleRequestCount;
    expect((await getGeneration()).dataGeneration).toBe(lastGeneration);
    expect(googleRequestCount).toBe(requestsBefore);
  });

  it('rejects pagination cursors after a row changes sort position between pages', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'score'],
        ['row-a', '1'],
        ['row-b', '2'],
        ['row-c', '3']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, {
      indexedFields: ['score'],
      fieldRules: { score: { type: 'number' } },
      cacheTtlSeconds: 3600
    });

    const firstPage = await listUsers(env, { sort: 'score:asc', limit: 1 });
    expect(firstPage.data.map((row) => row.id)).toEqual(['row-a']);

    await updateUser(env, 'row-b', { score: '0' });

    await expect(listUsers(env, { sort: 'score:asc', limit: 1, cursor: firstPage.nextCursor })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Pagination cursor is stale because the table data changed after it was issued. Restart pagination without a cursor.',
      details: { reason: 'stale-cursor' }
    });
  });

  it('keeps pagination cursors valid across a resync that leaves the cached rows unchanged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const sheet: SheetState = {
      rows: [
        ['_id', 'score'],
        ['row-a', '1'],
        ['row-b', '2']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, {
      indexedFields: ['score'],
      fieldRules: { score: { type: 'number' } },
      cacheTtlSeconds: 1
    });

    const firstPage = await listUsers(env, { sort: 'score:asc', limit: 1 });
    vi.setSystemTime(new Date('2026-10-28T12:00:05.000Z'));
    sheet.requestedRanges = [];
    const secondPage = await listUsers(env, { sort: 'score:asc', limit: 1, cursor: firstPage.nextCursor });

    expect(sheet.requestedRanges).toContain("'Users'!A1:B");
    expect(secondPage.data.map((row) => row.id)).toEqual(['row-b']);
    vi.useRealTimers();
  });

  it('keeps an external change recorded during a sync pending after that sync completes', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    const snapshotRead = createSignal();
    const releaseSnapshot = createSignal();
    let gateNextSnapshot = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (gateNextSnapshot && decodeRangeFromUrl(String(input)) === "'Users'!A1:B") {
        gateNextSnapshot = false;
        const snapshot = await baseFetch(input, init);
        snapshotRead.resolve();
        await releaseSnapshot.promise;
        return snapshot;
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    gateNextSnapshot = true;
    const reindex = callUsersTable(env, {
      type: 'table.reindex',
      ...usersTable,
      requestContext: {
        requestId: 'req-auto',
        route: 'control.spreadsheet-watch.alarm',
        principal: 'system:drive-watch',
        syncSource: 'external-change'
      }
    }, 'table.reindex.result');
    await snapshotRead.promise;

    sheet.rows = [
      ['_id', 'name'],
      ['row-1', 'Ada Lovelace']
    ];
    await callUsersTable(env, {
      type: 'table.external-change.record',
      ...usersTable,
      changedAt: '2026-10-28T12:00:00.000Z',
      debounceUntil: null
    }, 'table.external-change.record.result');
    releaseSnapshot.resolve();
    await reindex;

    const status = await getUsersCacheStatus(env);
    expect(status).toMatchObject({
      stale: true,
      staleReason: 'external-change',
      externalChange: {
        pending: true,
        lastChangedAt: '2026-10-28T12:00:00.000Z'
      }
    });
    expect(status.externalChange.lastAutoReindexAt).not.toBeNull();

    const rows = await listUsers(env);
    expect(rows.data.map((row) => row.values.name)).toEqual(['Ada Lovelace']);
    expect((await getUsersCacheStatus(env)).externalChange.pending).toBe(false);
  });

  it('runs its own sync when the in-flight sync was started for a different table config', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name', 'status'],
        ['row-1', 'Ada', 'active'],
        ['row-2', 'Bea', 'draft']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    const snapshotRead = createSignal();
    const releaseSnapshot = createSignal();
    let gateNextSnapshot = false;
    let snapshotReads = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (decodeRangeFromUrl(String(input)) === "'Users'!A1:C") {
        snapshotReads += 1;
        if (gateNextSnapshot) {
          gateNextSnapshot = false;
          const snapshot = await baseFetch(input, init);
          snapshotRead.resolve();
          await releaseSnapshot.promise;
          return snapshot;
        }
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { indexedFields: ['name'], cacheTtlSeconds: 3600 });

    gateNextSnapshot = true;
    const configAList = listUsers(env);
    await snapshotRead.promise;
    await createUsersTable(env, { indexedFields: ['name', 'status'], cacheTtlSeconds: 3600 });
    const configBList = listUsers(env, { filter: { status: { eq: 'active' } } });
    // Let request B reach the in-flight config-A sync before releasing it. setImmediate yields
    // event-loop turns without a wall-clock delay; nothing observable marks "waiting on a sync".
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseSnapshot.resolve();
    await configAList;

    expect((await configBList).data.map((row) => row.id)).toEqual(['row-1']);
    expect(snapshotReads).toBe(2);
  });

  it('keeps writes committed during a sync from being lost when that sync promotes its older snapshot', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const gate = createSnapshotGate(createSheetsFetch(sheet), "'Users'!A1:B");
    vi.stubGlobal('fetch', gate.fetch);
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    gate.arm();
    const reindex = callUsersTable(env, { type: 'table.reindex', ...usersTable }, 'table.reindex.result');
    await gate.reached;
    await updateUser(env, 'row-1', { name: 'Ada Lovelace' });
    const created = await createUser(env, { name: 'Grace' });
    expect((await listUsers(env)).data.map((row) => row.values.name)).toEqual(['Ada Lovelace', 'Grace']);

    gate.release();
    await reindex;

    // The promoted snapshot predates both writes, so the cache must not claim to be fresh.
    expect(await getUsersCacheStatus(env)).toMatchObject({ stale: true, staleReason: 'external-change' });
    expect((await listUsers(env)).data.map((row) => [row.id, row.values.name])).toEqual([
      ['row-1', 'Ada Lovelace'],
      [created.data.id, 'Grace']
    ]);
    expect(await getUsersCacheStatus(env)).toMatchObject({ stale: false, staleReason: 'fresh' });
  });

  it('does not hand a read that arrives after a write the snapshot of a sync that began before that write', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const gate = createSnapshotGate(createSheetsFetch(sheet), "'Users'!A1:B");
    vi.stubGlobal('fetch', gate.fetch);
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    gate.arm();
    const reindex = callUsersTable(env, { type: 'table.reindex', ...usersTable }, 'table.reindex.result');
    await gate.reached;
    await updateUser(env, 'row-1', { name: 'Ada Lovelace' });
    // A pending change makes the next read sync, and it arrives while the older sync is in flight.
    await callUsersTable(env, {
      type: 'table.external-change.record',
      ...usersTable,
      changedAt: '2026-10-28T12:00:00.000Z',
      debounceUntil: null
    }, 'table.external-change.record.result');
    const lateRead = listUsers(env);
    // Let the read reach the in-flight sync before releasing it (see the config-change test above).
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    gate.release();
    await reindex;

    expect((await lateRead).data.map((row) => row.values.name)).toEqual(['Ada Lovelace']);
  });

  it('rejects a sync whose data read returns a different header row than the layout read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let serveStaleHeaderRow = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (serveStaleHeaderRow && decodeRangeFromUrl(String(input)) === "'Users'!1:1") {
        return Response.json({ values: [['_id', 'name']] });
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);
    const before = await getUsersCacheStatus(env);

    sheet.rows = [
      ['_id', 'email', 'name'],
      ['row-1', 'ada@example.com', 'Ada']
    ];
    serveStaleHeaderRow = true;

    await expect(callUsersTable(env, { type: 'table.reindex', ...usersTable }, 'table.reindex.result')).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      message: 'The sheet header row changed while the table snapshot was being read. Retry the request.'
    });
    expect(await getUsersCacheStatus(env)).toMatchObject({
      status: 'error',
      rowCount: 1,
      lastSyncCompletedAt: before.lastSyncCompletedAt
    });
  });

  it('verifies fresh point updates and deletes without reading the whole managed id column', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    sheet.requestedRanges = [];
    await updateUser(env, 'row-2', { name: 'Bea Smith' });
    await deleteUser(env, 'row-3');
    expect(sheet.requestedRanges).not.toContain("'Users'!A2:A");
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-1', 'Ada'],
      ['row-2', 'Bea Smith']
    ]);

    sheet.rows = [
      ['_id', 'name'],
      ['row-2', 'Bea Smith'],
      ['row-1', 'Ada']
    ];
    sheet.requestedRanges = [];
    const moved = await updateUser(env, 'row-1', { name: 'Ada Lovelace' });

    expect(moved.data.rowNumber).toBe(3);
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-2', 'Bea Smith'],
      ['row-1', 'Ada Lovelace']
    ]);
  });

  it('re-resolves the appended row before patching when rows are inserted above it during create', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let insertAfterAppend = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await baseFetch(input, init);
      if (insertAfterAppend && String(input).includes(':append')) {
        insertAfterAppend = false;
        sheet.rows.splice(1, 0, ['row-manual', 'Manual']);
      }

      return response;
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    const created = await createUser(env, { name: 'Grace' });

    expect(created.data).toMatchObject({ rowNumber: 4, values: { name: 'Grace' } });
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-manual', 'Manual'],
      ['row-1', 'Ada'],
      [created.data.id, 'Grace']
    ]);
    expect((await getUsersCacheStatus(env)).staleReason).toBe('external-change');
  });

  it('fails closed and marks the cache stale when the written row no longer has the target id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let insertBeforePatch = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (insertBeforePatch && String(input).includes('/values:batchUpdate')) {
        insertBeforePatch = false;
        sheet.rows.splice(1, 0, ['row-manual', 'Manual']);
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    insertBeforePatch = true;
    await expect(updateUser(env, 'row-1', { name: 'Ada Lovelace' })).rejects.toMatchObject({
      name: 'ConflictError',
      details: { rowId: 'row-1', rowNumber: 2 }
    });
    expect(await getUsersCacheStatus(env)).toMatchObject({ stale: true, staleReason: 'external-change' });
  });

  it('removes an orphaned skeleton and marks the cache stale when an append response is lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let loseAppendResponse = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await baseFetch(input, init);
      if (loseAppendResponse && String(input).includes(':append')) {
        loseAppendResponse = false;
        throw new Error('socket hang up');
      }

      return response;
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    await expect(createUser(env, { name: 'Grace' })).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-1', 'Ada']
    ]);
    expect(await getUsersCacheStatus(env)).toMatchObject({ stale: true, staleReason: 'external-change' });
  });

  it('does not serve stale cache after update or delete responses are lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let loseResponseFor: string | null = null;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await baseFetch(input, init);
      if (loseResponseFor && String(input).includes(loseResponseFor)) {
        loseResponseFor = null;
        throw new Error('socket hang up');
      }

      return response;
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    loseResponseFor = '/values:batchUpdate';
    await expect(updateUser(env, 'row-1', { name: 'Ada Lovelace' })).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect((await listUsers(env)).data.map((row) => row.values.name)).toEqual(['Ada Lovelace', 'Bea']);

    loseResponseFor = ':batchUpdate';
    await expect(deleteUser(env, 'row-2')).rejects.toMatchObject({ name: 'ServiceUnavailableError' });
    expect((await listUsers(env)).data.map((row) => row.id)).toEqual(['row-1']);
  });

  it('runs concurrent row writes one at a time so each lands on its own row', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'a'],
        ['row-2', 'b'],
        ['row-3', 'c'],
        ['row-4', 'd'],
        ['row-5', 'e'],
        ['row-6', 'f']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    // Writes address Google rows by index, so interleaved deletes would shift one another's targets.
    await Promise.all([
      deleteUser(env, 'row-2'),
      deleteUser(env, 'row-3'),
      updateUser(env, 'row-6', { name: 'F' }),
      deleteUser(env, 'row-5')
    ]);

    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-1', 'a'],
      ['row-4', 'd'],
      ['row-6', 'F']
    ]);
    expect((await listUsers(env)).data.map((row) => [row.id, row.rowNumber, row.values.name])).toEqual([
      ['row-1', 2, 'a'],
      ['row-4', 3, 'd'],
      ['row-6', 4, 'F']
    ]);
  });

  it('checks a unique field against the rows written by the create that ran before it', async () => {
    const sheet: SheetState = {
      rows: [['_id', 'email']],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, {
      indexedFields: ['email'],
      cacheTtlSeconds: 3600,
      fieldRules: { email: { unique: true } }
    });
    await listUsers(env);

    const outcomes = await Promise.allSettled([
      createUser(env, { email: 'ada@example.com' }),
      createUser(env, { email: 'ada@example.com' })
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({ reason: { name: 'ConflictError', message: 'email must be unique.' } });
    expect(sheet.rows.filter((row) => row[1] === 'ada@example.com')).toHaveLength(1);

    // A rejected write must not stall the queue behind it.
    await expect(createUser(env, { email: 'bea@example.com' })).resolves.toMatchObject({ data: { values: { email: 'bea@example.com' } } });
  });

  it('fails closed and marks the cache stale when rows shift by more than one position while a delete is in flight', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'a'],
        ['row-2', 'b'],
        ['row-3', 'c'],
        ['row-4', 'd'],
        ['row-5', 'e'],
        ['row-6', 'f']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let shiftBeforeDelete = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (shiftBeforeDelete && String(input).includes(':batchUpdate') && !String(input).includes('/values:batchUpdate')) {
        shiftBeforeDelete = false;
        // Three rows land above the target after its row was resolved, so the delete removes a different row.
        sheet.rows.splice(1, 0, ['manual-1', 'x'], ['manual-2', 'x'], ['manual-3', 'x']);
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    shiftBeforeDelete = true;
    await expect(deleteUser(env, 'row-5')).rejects.toMatchObject({
      name: 'ConflictError',
      details: { rowId: 'row-5' }
    });

    // The cache must not claim row-5 is gone: the next read resyncs and shows what the sheet holds.
    expect(await getUsersCacheStatus(env)).toMatchObject({ stale: true, staleReason: 'external-change' });
    expect((await listUsers(env)).data.map((row) => row.id)).toEqual([
      'manual-1',
      'manual-2',
      'manual-3',
      'row-1',
      'row-3',
      'row-4',
      'row-5',
      'row-6'
    ]);
  });

  it('deletes the first and the last data rows, which have no neighbour on one side', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'a'],
        ['row-2', 'b'],
        ['row-3', 'c']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    await deleteUser(env, 'row-3');
    await deleteUser(env, 'row-1');

    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-2', 'b']
    ]);
    expect((await listUsers(env)).data.map((row) => [row.id, row.rowNumber])).toEqual([['row-2', 2]]);
  });

  it('rejects a fresh-cache update or delete when the target id is repeated in the row beside it', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    // Someone copies row-1 into the next row. No change signal has arrived, so the cache looks fresh.
    sheet.rows.splice(2, 0, ['row-1', 'Copy']);

    await expect(updateUser(env, 'row-1', { name: 'Ada Lovelace' })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate managed row id detected for row-1.'
    });
    await expect(deleteUser(env, 'row-1')).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate managed row id detected for row-1.'
    });
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['row-1', 'Ada'],
      ['row-1', 'Copy'],
      ['row-2', 'Bea']
    ]);
  });

  it('lets a fresh-cache update through when the duplicate id is not adjacent, and rejects it at the next sync', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };
    vi.stubGlobal('fetch', createSheetsFetch(sheet));
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    // The copy is outside the rows a point write reads, so only a sync can see it.
    sheet.rows.push(['row-1', 'Copy']);

    const updated = await updateUser(env, 'row-1', { name: 'Ada Lovelace' });
    expect(updated.data.rowNumber).toBe(2);
    expect(sheet.rows[1]).toEqual(['row-1', 'Ada Lovelace']);
    await expect(callUsersTable(env, { type: 'table.reindex', ...usersTable }, 'table.reindex.result')).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate managed row id detected for row-1.'
    });
  });

  it('checks the neighbours after a delete on an expired cache, where the target is found by an id-column scan', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'a'],
        ['row-2', 'b'],
        ['row-3', 'c'],
        ['row-4', 'd']
      ],
      requestedRanges: []
    };
    const baseFetch = createSheetsFetch(sheet);
    let shiftBeforeDelete = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (shiftBeforeDelete && String(input).includes(':batchUpdate') && !String(input).includes('/values:batchUpdate')) {
        shiftBeforeDelete = false;
        sheet.rows.splice(1, 0, ['manual-1', 'x'], ['manual-2', 'x'], ['manual-3', 'x']);
      }

      return baseFetch(input, init);
    });
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 1 });
    await listUsers(env);
    vi.setSystemTime(new Date('2026-10-28T12:00:05.000Z'));

    shiftBeforeDelete = true;
    await expect(deleteUser(env, 'row-3')).rejects.toMatchObject({
      name: 'ConflictError',
      details: { rowId: 'row-3' }
    });
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");

    vi.useRealTimers();
  });

  it('does not hold up the next write while a delete rebuilds the cache', async () => {
    const sheet: SheetState = {
      rows: [
        ['_id', 'name'],
        ['row-1', 'Ada'],
        ['row-2', 'Bea'],
        ['row-3', 'Cora']
      ],
      requestedRanges: []
    };
    const gate = createSnapshotGate(createSheetsFetch(sheet), "'Users'!A1:C");
    vi.stubGlobal('fetch', gate.fetch);
    const env = createTestEnv();
    await createUsersTable(env, { cacheTtlSeconds: 3600 });
    await listUsers(env);

    // A column added by hand means the delete cannot repair the cache in place and rebuilds it.
    sheet.rows = sheet.rows.map((row, index) => [...row, index === 0 ? 'status' : 'active']);
    gate.arm();
    const deletion = deleteUser(env, 'row-1');
    await gate.reached;

    // The rebuild is still reading Google, and a write must not queue behind it.
    await updateUser(env, 'row-3', { name: 'Cora Lee' });

    gate.release();
    await deletion;
    expect((await listUsers(env)).data.map((row) => [row.id, row.values.name])).toEqual([
      ['row-2', 'Bea'],
      ['row-3', 'Cora Lee']
    ]);
  });
});
