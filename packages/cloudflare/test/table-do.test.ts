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
          { field: 'score', code: 'TYPE' },
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
            _id: 42,
            name: 'Ada'
          }
        }
      }
    });
    expect(sheet.rows).toEqual([
      ['_id', 'name'],
      ['42', 'Ada']
    ]);
    expect(sheet.requestedRanges.filter((range) => range === "'Users'!1:1")).toHaveLength(1);
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
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");
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
    expect(sheet.requestedRanges).toContain("'Users'!A2:A");
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

  it('rejects updates when a cached row id has become duplicated upstream', async () => {
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
      result: { data: { lastSyncStartedAt: string | null; lastSyncCompletedAt: string | null } };
    }).result.data).toMatchObject({
      lastSyncStartedAt: '2026-04-26T12:00:00.000Z',
      lastSyncCompletedAt: '2026-04-26T12:00:00.000Z'
    });
    expect((cacheStatusAfterMutation as {
      type: 'table.cache.get.result';
      result: { data: { lastSyncStartedAt: string | null; lastSyncCompletedAt: string | null; stale: boolean; rowCount: number } };
    }).result.data).toMatchObject({
      lastSyncStartedAt: '2026-04-26T12:00:00.000Z',
      lastSyncCompletedAt: '2026-04-26T12:00:00.000Z',
      stale: false,
      rowCount: 1
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
            { name: 'score', inferredType: 'number', nullable: true }
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
});
