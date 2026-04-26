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
  it('parses primitives and arrays', () => {
    expect(parseSheetCellValue('')).toBeNull();
    expect(parseSheetCellValue('42')).toBe(42);
    expect(parseSheetCellValue('true')).toBe(true);
    expect(parseSheetCellValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseSheetCellValue('Ada')).toBe('Ada');
  });
});

describe('GoogleSheetsService.readAllRows', () => {
  it('respects configured header and data rows', async () => {
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
              ['intro'],
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

    expect(valueFetchCount).toBe(2);
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
});
