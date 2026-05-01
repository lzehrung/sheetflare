import { ServiceUnavailableError, TooManyRequestsError } from '@sheetflare/contracts';
import { describe, expect, it } from 'vitest';
import { GoogleSheetsService, parseSheetCellValue, serializeSheetCell, type GoogleSheetTableConfig } from '../src';

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

describe('serializeSheetCell', () => {
  it('serializes arrays to json strings', () => {
    expect(serializeSheetCell(['a', 'b'])).toBe('["a","b"]');
  });
});

describe('parseSheetCellValue', () => {
  it('preserves raw sheet text instead of inferring types from strings', () => {
    expect(parseSheetCellValue('')).toBeNull();
    expect(parseSheetCellValue('42')).toBe('42');
    expect(parseSheetCellValue('true')).toBe('true');
    expect(parseSheetCellValue('["a","b"]')).toBe('["a","b"]');
    expect(parseSheetCellValue('00123')).toBe('00123');
    expect(parseSheetCellValue('Ada')).toBe('Ada');
  });
});

describe('GoogleSheetsService.readAllRows', () => {
  it('uses the live global fetch at call time instead of storing a detached reference', async () => {
    const staleFetch = async () => {
      throw new Error('stale fetch should not be used');
    };

    const liveFetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({
          access_token: 'token',
          expires_in: 3600
        });
      }

      if (url.includes('/values/')) {
        return Response.json({
          values: [
            ['_id', 'name'],
            ['row-1', 'Ada']
          ]
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = staleFetch as typeof fetch;

    try {
      const service = new GoogleSheetsService({
        clientEmail: 'service@example.com',
        privateKey: testPrivateKey
      });

      globalThis.fetch = liveFetch as typeof fetch;

      await expect(service.readAllRows({
        projectSlug: 'demo',
        tableSlug: 'users',
        spreadsheetId: 'sheet-1',
        sheetTabName: 'Users',
        idColumn: '_id',
        indexedFields: ['_id'],
        headerRow: 1,
        dataStartRow: 2,
        readEnabled: true,
        createEnabled: true,
        updateEnabled: true,
        deleteEnabled: true,
        cacheTtlSeconds: 15,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z'
      })).resolves.toEqual([
        {
          id: 'row-1',
          rowNumber: 2,
          values: {
            _id: 'row-1',
            name: 'Ada'
          }
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects duplicate non-empty header names', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes('/values/')) {
          return Response.json({
            values: [
              ['_id', 'name', 'name'],
              ['row-1', 'Ada', 'Duplicate']
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(service.readAllRows({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Duplicate header "name" was found in the configured sheet header row.'
    });
  });

  it('respects configured header and data rows', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!2:2")) {
          return Response.json({
            values: [['_id', 'name']]
          });
        }

        if (url.includes("/values/'Users'!A2:B")) {
          return Response.json({
            values: [
              ['_id', 'name'],
              ['row-1', 'Ada'],
              ['row-2', 'Grace']
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const config: GoogleSheetTableConfig = {
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 2,
      dataStartRow: 3,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    };

    const rows = await service.readAllRows(config);

    expect(rows).toEqual([
      {
        id: 'row-1',
        rowNumber: 3,
        values: {
          _id: 'row-1',
          name: 'Ada'
        }
      },
      {
        id: 'row-2',
        rowNumber: 4,
        values: {
          _id: 'row-2',
          name: 'Grace'
        }
      }
    ]);
  });

  it('bounds table snapshot reads to the declared header width instead of reading the full tab', async () => {
    const requestedUrls: string[] = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        requestedUrls.push(url);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!1:1")) {
          return Response.json({
            values: [['_id', 'name', 'status']]
          });
        }

        if (url.includes("/values/'Users'!A1:C")) {
          return Response.json({
            values: [
              ['_id', 'name', 'status'],
              ['row-1', 'Ada', 'active']
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const rows = await service.readAllRows({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    });

    expect(rows).toHaveLength(1);
    expect(requestedUrls.some((url) => url.includes("/values/'Users'!A1:C"))).toBe(true);
    expect(requestedUrls.every((url) => !url.endsWith("/values/'Users'"))).toBe(true);
  });

  it('rejects rows with blank managed ids instead of fabricating row-number ids', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes('/values/')) {
          return Response.json({
            values: [
              ['_id', 'name'],
              ['', 'Ada']
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(service.readAllRows({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    })).rejects.toMatchObject({
      name: 'BadRequestError',
      message: 'Blank managed row id detected in column _id at row 2.'
    });
  });

  it('retries transient read failures before succeeding', async () => {
    let valueFetchCount = 0;
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      delay: async () => {},
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes('/values/')) {
          valueFetchCount += 1;
          if (valueFetchCount === 1) {
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

          return Response.json({
            values: [['_id', 'name'], ['row-1', 'Ada']]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const rows = await service.readAllRows({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    });

    expect(valueFetchCount).toBe(3);
    expect(rows).toHaveLength(1);
  });

  it('classifies quota failures distinctly', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      delay: async () => {},
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        return new Response(JSON.stringify({
          error: {
            message: 'Quota exceeded'
          }
        }), {
          status: 429,
          headers: {
            'content-type': 'application/json'
          }
        });
      }
    });

    await expect(service.readHeaders({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    })).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('classifies non-timeout transport failures distinctly', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      delay: async () => {},
      fetch: async (input) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          throw new Error('socket hang up');
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(service.readHeaders({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    })).rejects.toMatchObject({
      name: ServiceUnavailableError.name,
      message: 'Google Sheets network request failed during fetch Google OAuth access token.'
    });
  });

  it('preserves sparse header column positions when mapping row values', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'")) {
          return Response.json({
            values: [
              ['name', '', '_id'],
              ['Ada', '', 'row-1']
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const rows = await service.readAllRows({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    });

    expect(rows).toEqual([
      {
        id: 'row-1',
        rowNumber: 2,
        values: {
          name: 'Ada',
          _id: 'row-1'
        }
      }
    ]);
  });

  it('finds rows by scanning only the managed id column when the hint is stale', async () => {
    const requestedRanges: string[] = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        const range = url.match(/\/values\/([^?]+)/)?.[1] ?? null;
        if (!range) {
          throw new Error(`Unexpected request: ${url}`);
        }

        requestedRanges.push(range);

        if (range === "'Users'!1:1") {
          return Response.json({
            values: [['name', '_id']]
          });
        }

        if (range === "'Users'!A2:B2") {
          return Response.json({
            values: [['Ada', 'row-2']]
          });
        }

        if (range === "'Users'!B2:B") {
          return Response.json({
            values: [['row-2'], ['row-1']]
          });
        }

        if (range === "'Users'!A3:B3") {
          return Response.json({
            values: [['Grace', 'row-1']]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const result = await service.findRowById({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    }, 'row-1', 2);

    expect(result).toEqual({
      row: {
        id: 'row-1',
        rowNumber: 3,
        values: {
          name: 'Grace',
          _id: 'row-1'
        }
      },
      duplicateCount: 1
    });
    expect(requestedRanges).toEqual([
      "'Users'!1:1",
      "'Users'!A2:B2",
      "'Users'!B2:B",
      "'Users'!A3:B3"
    ]);
    expect(requestedRanges).not.toContain("'Users'");
  });

  it('preserves a literal string row id of null in row reference scans', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!1:1")) {
          return Response.json({
            values: [['_id', 'name']]
          });
        }

        if (url.includes("/values/'Users'!A2:A")) {
          return Response.json({
            values: [['null']]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const references = await service.readRowReferences({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    });

    expect(references).toEqual([
      {
        rowId: 'null',
        rowNumber: 2
      }
    ]);
  });
});

describe('GoogleSheetsService.listSheetTabs', () => {
  it('lists spreadsheet tabs with titles and gids', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
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
                  title: ' Users ',
                  sheetId: 11,
                  sheetType: 'GRID'
                }
              },
              {
                properties: {
                  title: 'Archive',
                  sheetId: 12,
                  sheetType: 'GRID'
                }
              },
              {
                properties: {
                  title: '',
                  sheetId: 13,
                  sheetType: 'GRID'
                }
              },
              {
                properties: {
                  title: 'Chart 1',
                  sheetId: 14,
                  sheetType: 'OBJECT'
                }
              },
              {
                properties: {
                  title: 'Missing id'
                }
              }
            ]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(service.listSheetTabs('sheet-1')).resolves.toEqual([
      {
        title: ' Users ',
        sheetGid: 11
      },
      {
        title: 'Archive',
        sheetGid: 12
      }
    ]);
  });
});

describe('GoogleSheetsService.readHeaderNames', () => {
  it('reads header names without requiring the managed id column', async () => {
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!3:3")) {
          return Response.json({
            values: [['Email', 'Status', 'Derived']]
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await expect(service.readHeaderNames('sheet-1', 'Users', 3)).resolves.toEqual([
      'Email',
      'Status',
      'Derived'
    ]);
  });
});

describe('GoogleSheetsService Drive watch lifecycle', () => {
  it('registers a Drive webhook watch for a spreadsheet file', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          url,
          body:
            init?.body && typeof init.body === 'string' && init.body.trim().startsWith('{')
              ? JSON.parse(init.body)
              : null
        });

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes('/drive/v3/files/sheet-1/watch')) {
          return Response.json({
            id: 'channel-1',
            resourceId: 'resource-1',
            resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
            expiration: String(Date.parse('2026-05-01T00:00:00.000Z'))
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const watch = await service.watchSpreadsheetFile('sheet-1', {
      webhookUrl: 'https://sheetflare.example/v1/system/google/drive/notifications',
      token: 'secret-token',
      expirationMs: Date.parse('2026-05-01T00:00:00.000Z')
    });

    expect(watch).toEqual({
      channelId: 'channel-1',
      resourceId: 'resource-1',
      resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
      expirationAt: '2026-05-01T00:00:00.000Z'
    });
    expect(requests.find((request) => request.url.includes('/drive/v3/files/sheet-1/watch'))).toMatchObject({
      method: 'POST',
      body: {
        type: 'web_hook',
        address: 'https://sheetflare.example/v1/system/google/drive/notifications',
        token: 'secret-token',
        expiration: String(Date.parse('2026-05-01T00:00:00.000Z'))
      }
    });
  });

  it('stops an existing Drive webhook channel cleanly', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          url,
          body:
            init?.body && typeof init.body === 'string' && init.body.trim().startsWith('{')
              ? JSON.parse(init.body)
              : null
        });

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.endsWith('/drive/v3/channels/stop')) {
          return Response.json({});
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await service.stopDriveChannel('channel-1', 'resource-1');

    expect(requests.find((request) => request.url.endsWith('/drive/v3/channels/stop'))).toMatchObject({
      method: 'POST',
      body: {
        id: 'channel-1',
        resourceId: 'resource-1'
      }
    });
  });
});

describe('GoogleSheetsService.writeRow', () => {
  it('sends raw values to Sheets so the API preserves literal cell contents', async () => {
    const requestedUrls: string[] = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes(':append')) {
          return Response.json({
            updates: {
              updatedRange: `'Users'!A2:B2`
            }
          });
        }

        if (init?.method === 'PUT') {
          return Response.json({});
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const config: GoogleSheetTableConfig = {
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    };

    await service.appendRow(config, ['_id', 'name'], {
      _id: '001',
      name: 'Ada'
    });
    await service.writeRow(config, 2, ['_id', 'name'], {
      _id: '001',
      name: 'Ada'
    });

    expect(requestedUrls.some((url) => url.includes('valueInputOption=RAW'))).toBe(true);
    expect(requestedUrls.every((url) => !url.includes('valueInputOption=USER_ENTERED'))).toBe(true);
  });

  it('patches only the provided writable column segments and preserves gaps', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input, init) => {
        const url = decodeURIComponent(String(input));
        const method = init?.method ?? 'GET';
        requests.push({
          method,
          url,
          body:
            init?.body && typeof init.body === 'string' && init.body.trim().startsWith('{')
              ? JSON.parse(init.body)
              : null
        });

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!1:1")) {
          return Response.json({
            values: [['_id', 'name', 'derived', 'status']]
          });
        }

        if (url.includes('/values:batchUpdate')) {
          return Response.json({});
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    await service.writeRowPatch({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      readOnlyFields: ['derived'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    }, 4, {
      name: 'Ada',
      status: 'active'
    });

    const batchUpdate = requests.find((request) => request.url.includes('/values:batchUpdate'));
    expect(batchUpdate).toBeTruthy();
    expect(batchUpdate?.body).toEqual({
      valueInputOption: 'RAW',
      data: [
        {
          range: "'Users'!B4:B4",
          values: [['Ada']]
        },
        {
          range: "'Users'!D4:D4",
          values: [['active']]
        }
      ]
    });
  });

  it('appends a row skeleton through the managed id column when writable columns are sparse', async () => {
    const requestedUrls: string[] = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        requestedUrls.push(url);

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!1:1")) {
          return Response.json({
            values: [['name', '_id', 'derived', 'status']]
          });
        }

        if (url.includes(':append')) {
          return Response.json({
            updates: {
              updatedRange: "'Users'!B5:B5"
            }
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const rowNumber = await service.appendRowSkeleton({
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      readOnlyFields: ['derived'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    }, 'row-5');

    expect(rowNumber).toBe(5);
    expect(requestedUrls.some((url) => url.includes("/values/'Users'!B2:B:append"))).toBe(true);
  });

  it('reuses a previously resolved header layout across sparse mutation helpers', async () => {
    const requestedUrls: string[] = [];
    const service = new GoogleSheetsService({
      clientEmail: 'service@example.com',
      privateKey: testPrivateKey,
      fetch: async (input) => {
        const url = decodeURIComponent(String(input));
        requestedUrls.push(url);

        if (url.includes('oauth2.googleapis.com/token')) {
          return Response.json({
            access_token: 'token',
            expires_in: 3600
          });
        }

        if (url.includes("/values/'Users'!1:1")) {
          return Response.json({
            values: [['name', '_id', 'derived', 'status']]
          });
        }

        if (url.includes("/values/'Users'!B2:B:append")) {
          return Response.json({
            updates: {
              updatedRange: "'Users'!B5:B5"
            }
          });
        }

        if (url.includes("/values/'Users'!A5:D5")) {
          return Response.json({
            values: [['Ada', 'row-5', 'derived', 'active']]
          });
        }

        if (url.includes('/values:batchUpdate')) {
          return Response.json({});
        }

        throw new Error(`Unexpected request: ${url}`);
      }
    });

    const config = {
      projectSlug: 'demo',
      tableSlug: 'users',
      spreadsheetId: 'sheet-1',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      readOnlyFields: ['derived'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    } satisfies GoogleSheetTableConfig;

    const layout = await service.getHeaderLayout(config);
    const rowNumber = await service.appendRowSkeleton(config, 'row-5', layout);
    await service.writeRowPatch(config, rowNumber, {
      name: 'Ada',
      status: 'active'
    }, layout);
    await service.readSingleRow(config, rowNumber, layout);

    expect(requestedUrls.filter((url) => url.includes("/values/'Users'!1:1"))).toHaveLength(1);
    expect(requestedUrls).toContain("https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/'Users'!A5:D5");
  });
});
