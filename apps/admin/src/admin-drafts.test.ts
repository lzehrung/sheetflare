import { describe, expect, it } from 'vitest';
import {
  initialCreateKeyDraft,
  initialCreateProjectDraft,
  initialCreateTableDraft,
  validateCreateKeyDraft,
  validateCreateProjectDraft,
  validateCreateTableDraft
} from './admin-drafts';

describe('validateCreateProjectDraft', () => {
  it('rejects invalid slugs before submit', () => {
    const result = validateCreateProjectDraft({
      ...initialCreateProjectDraft,
      slug: 'Demo Project',
      name: 'Demo',
      spreadsheetId: 'sheet-1'
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.slug).toBe('Use lowercase letters, numbers, and single hyphens.');
  });
});

describe('validateCreateTableDraft', () => {
  it('surfaces integer and layout errors for table drafts', () => {
    const result = validateCreateTableDraft({
      ...initialCreateTableDraft,
      tableSlug: 'users',
      sheetTabName: 'Users',
      headerRow: '2',
      dataStartRow: '1',
      cacheTtlSeconds: '-1'
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.dataStartRow).toBe('dataStartRow must be greater than headerRow.');
    expect(result.fieldErrors.cacheTtlSeconds).toBe('Cache TTL must be a non-negative integer.');
  });

  it('parses valid drafts into the contract input shape', () => {
    const result = validateCreateTableDraft({
      ...initialCreateTableDraft,
      tableSlug: 'users',
      sheetTabName: 'Users',
      sheetGid: '12',
      readOnlyFields: 'derived,status_label'
    });

    expect(result.isValid).toBe(true);
    expect(result.value).toEqual(
      expect.objectContaining({
        tableSlug: 'users',
        sheetTabName: 'Users',
        sheetGid: 12,
        readOnlyFields: ['derived', 'status_label'],
        headerRow: 1,
        dataStartRow: 2,
        cacheTtlSeconds: 15
      })
    );
  });
});

describe('validateCreateKeyDraft', () => {
  it('requires a selected project for project-scoped keys', () => {
    const result = validateCreateKeyDraft(initialCreateKeyDraft, null);

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.projectScoped).toBe('Select a project before creating a scoped key.');
  });
});
