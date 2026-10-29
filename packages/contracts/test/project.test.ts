import { describe, expect, it } from 'vitest';
import { createTableInputSchema, resolvedTableConfigSnapshotSchema, tableConfigSchema } from '../src';

const tableConfig = {
  projectSlug: 'demo',
  tableSlug: 'users',
  sheetTabName: 'Users',
  idColumn: '_id',
  indexedFields: ['_id'],
  headerRow: 1,
  dataStartRow: 2,
  readEnabled: true,
  createEnabled: true,
  updateEnabled: true,
  deleteEnabled: true,
  cacheTtlSeconds: 3600,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z'
};

describe('cacheTtlSeconds', () => {
  it('caps the cache TTL at one hour in every table config schema', () => {
    expect(createTableInputSchema.safeParse({ tableSlug: 'users', sheetTabName: 'Users', cacheTtlSeconds: 3600 }).success).toBe(true);
    expect(createTableInputSchema.safeParse({ tableSlug: 'users', sheetTabName: 'Users', cacheTtlSeconds: 3601 }).success).toBe(false);

    expect(tableConfigSchema.safeParse(tableConfig).success).toBe(true);
    expect(tableConfigSchema.safeParse({ ...tableConfig, cacheTtlSeconds: 3601 }).success).toBe(false);

    const resolvedConfig = { ...tableConfig, spreadsheetId: 'sheet-1', googleCredentialRef: 'default' };
    expect(resolvedTableConfigSnapshotSchema.safeParse(resolvedConfig).success).toBe(true);
    expect(resolvedTableConfigSnapshotSchema.safeParse({ ...resolvedConfig, cacheTtlSeconds: 3601 }).success).toBe(false);
  });
});
