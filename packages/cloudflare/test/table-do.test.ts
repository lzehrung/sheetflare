import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, type ProjectDoResponse, type TableDoResponse } from '@sheetflare/contracts';
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
      sheet.rows.push(body.values[0] ?? []);
      const rowNumber = sheet.rows.length;
      return Response.json({
        updates: {
          updatedRange: `'Users'!A${rowNumber}:B${rowNumber}`
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

    throw new Error(`Unhandled sheet range: ${range}`);
  };
}

function createTestEnv() {
  const partialEnv: Partial<CloudflareEnv> = {
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: testPrivateKey,
    GOOGLE_CREDENTIALS_JSON: JSON.stringify({
      secondary: {
        clientEmail: 'secondary@example.com',
        privateKey: testPrivateKey
      }
    })
  };

  const env = partialEnv as CloudflareEnv;
  env.CONTROL_PLANE_DO = createDurableObjectNamespace(env, ControlPlaneDO) as never;
  env.PROJECT_DO = createDurableObjectNamespace(env, ProjectDO) as never;
  env.TABLE_DO = createDurableObjectNamespace(env, TableDO) as never;
  env.RATE_LIMIT_DO = null as never;
  return env;
}

describe('TableDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

    expect((response as { type: 'project.create.result'; result: { project: { googleCredentialRef: string } } }).result.project.googleCredentialRef).toBe('default');
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
          indexedFields: [' status ', 'status', '  ']
        }
      }
    );

    expect(response).toMatchObject({
      type: 'project.table.create.result',
      result: {
        data: {
          idColumn: '_id',
          indexedFields: ['_id', 'status']
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
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");

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
            { name: 'status', inferredType: 'json', nullable: true }
          ]
        }
      }
    });
  });

  it('keeps scan-based pagination stable when the cursor row disappears between pages', async () => {
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

    const secondPage = await doRpc<TableDoResponse>(
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
          },
          cursor: firstResult.result.nextCursor
        }
      }
    );

    const secondResult = secondPage as {
      type: 'table.rows.list.result';
      result: {
        data: Array<{ id: string }>;
        nextCursor: string | null;
      };
    };

    expect(secondResult.result.data.map((row) => row.id)).toEqual(['row-3']);
    expect(secondResult.result.nextCursor).toBeNull();
  });
});
