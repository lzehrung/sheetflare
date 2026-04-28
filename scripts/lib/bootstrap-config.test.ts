import { describe, expect, it } from 'vitest';
import { parseBootstrapConfig } from './bootstrap-config';

describe('parseBootstrapConfig', () => {
  it('parses projects, tables, and api keys', () => {
    expect(parseBootstrapConfig({
      projects: [
        {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          tables: [
            {
              tableSlug: 'users',
              sheetTabName: 'Users',
              indexedFields: ['name'],
              fieldRules: {
                email: {
                  required: true,
                  unique: true,
                  normalize: ['trim', 'lowercase']
                }
              }
            }
          ]
        }
      ],
      apiKeys: [
        {
          name: 'demo-key',
          scopes: ['table:read']
        }
      ]
    })).toEqual({
      projects: [
        {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          tables: [
            {
              tableSlug: 'users',
              sheetTabName: 'Users',
              indexedFields: ['name'],
              fieldRules: {
                email: {
                  required: true,
                  unique: true,
                  normalize: ['trim', 'lowercase']
                }
              }
            }
          ]
        }
      ],
      apiKeys: [
        {
          name: 'demo-key',
          scopes: ['table:read']
        }
      ]
    });
  });

  it('fails fast with a precise table validation error', () => {
    expect(() =>
      parseBootstrapConfig({
        projects: [
          {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            tables: [
              {
                tableSlug: 'users',
                sheetTabName: 'Users',
                headerRow: 2,
                dataStartRow: 2
              }
            ]
          }
        ]
      })
    ).toThrow('Bootstrap config project 1 table 1 is invalid: dataStartRow: dataStartRow must be greater than headerRow.');
  });

  it('rejects non-array api keys up front', () => {
    expect(() =>
      parseBootstrapConfig({
        projects: [
          {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1'
          }
        ],
        apiKeys: {}
      })
    ).toThrow('SHEETFLARE_BOOTSTRAP_CONFIG_JSON field apiKeys must be an array when provided.');
  });
});
