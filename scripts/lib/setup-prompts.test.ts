import { describe, expect, it } from 'vitest';
import { buildBeginnerSetupConfigFromAnswers, buildSetupConfigFromAnswers } from './setup-prompts';

describe('buildBeginnerSetupConfigFromAnswers', () => {
  it('builds a beginner setup config with derived defaults', () => {
    const config = buildBeginnerSetupConfigFromAnswers({
      spreadsheetIdOrUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0',
      sheetTabName: 'Contacts 2026',
      smokeFieldName: 'name'
    });

    expect(config).toMatchObject({
      profile: 'production',
      deploy: {
        api: true,
        admin: true
      },
      privateProject: {
        slug: 'main',
        name: 'Main',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'contacts-2026',
            sheetTabName: 'Contacts 2026',
            idColumn: '_id',
            cacheTtlSeconds: 60
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'contacts-2026',
        publicTableSlug: null,
        adminKeyName: 'main-admin',
        privateReadKeyName: 'main-read',
        mutationKeyName: 'main-mutation',
        createValues: {
          name: 'Sheetflare smoke row'
        },
        updateValues: {
          name: 'Sheetflare smoke row updated'
        }
      }
    });
  });

  it('falls back to a generic table slug for punctuation-only tab names', () => {
    const config = buildBeginnerSetupConfigFromAnswers({
      spreadsheetIdOrUrl: 'sheet-1',
      sheetTabName: ' !!! ',
      smokeFieldName: 'name'
    });

    expect(config.privateProject.tables[0]?.tableSlug).toBe('table');
  });

  it('rejects a blank beginner smoke field name', () => {
    expect(() => buildBeginnerSetupConfigFromAnswers({
      spreadsheetIdOrUrl: 'sheet-1',
      sheetTabName: 'Users',
      smokeFieldName: '   '
    })).toThrow('Smoke field name must not be blank.');
  });

  it('rejects using the managed id column for beginner smoke writes', () => {
    expect(() => buildBeginnerSetupConfigFromAnswers({
      spreadsheetIdOrUrl: 'sheet-1',
      sheetTabName: 'Users',
      smokeFieldName: '_id'
    })).toThrow('Smoke field name must not use the managed ID column.');
  });
});

describe('buildSetupConfigFromAnswers', () => {
  it('builds a private-only setup config from prompt answers', () => {
    const config = buildSetupConfigFromAnswers({
      profile: 'local',
      deployAdmin: true,
      spreadsheetIdOrUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0',
      privateProjectSlug: 'demo',
      privateProjectName: 'Demo',
      privateTableSlug: 'users',
      privateSheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['email', 'status'],
      cacheTtlSeconds: 60,
      smokeFieldName: 'name',
      smokeCreateValue: 'Smoke Row',
      smokeUpdateValue: 'Smoke Row Updated',
      addPublicReadProject: false,
      publicReadProjectSlug: null,
      publicReadProjectName: null
    });

    expect(config).toMatchObject({
      deploy: {
        api: true,
        admin: true
      },
      privateProject: {
        slug: 'demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            indexedFields: ['email', 'status']
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke Row'
        }
      }
    });
  });

  it('derives a public-read project when requested', () => {
    const config = buildSetupConfigFromAnswers({
      profile: 'local',
      deployAdmin: false,
      spreadsheetIdOrUrl: 'sheet-1',
      privateProjectSlug: 'demo',
      privateProjectName: 'Demo',
      privateTableSlug: 'users',
      privateSheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: [],
      cacheTtlSeconds: 15,
      smokeFieldName: 'name',
      smokeCreateValue: 'Smoke Row',
      smokeUpdateValue: 'Smoke Row Updated',
      addPublicReadProject: true,
      publicReadProjectSlug: 'demo-public',
      publicReadProjectName: 'Demo Public'
    });

    expect(config).toMatchObject({
      deploy: {
        admin: false
      },
      publicReadProject: {
        slug: 'demo-public',
        tables: [
          {
            tableSlug: 'users',
            cacheTtlSeconds: 15
          }
        ]
      },
      smoke: {
        publicTableSlug: 'users'
      }
    });
  });

  it('rejects a blank smoke field name', () => {
    expect(() => buildSetupConfigFromAnswers({
      profile: 'local',
      deployAdmin: true,
      spreadsheetIdOrUrl: 'sheet-1',
      privateProjectSlug: 'demo',
      privateProjectName: 'Demo',
      privateTableSlug: 'users',
      privateSheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: [],
      cacheTtlSeconds: 60,
      smokeFieldName: '   ',
      smokeCreateValue: 'Smoke Row',
      smokeUpdateValue: 'Smoke Row Updated',
      addPublicReadProject: false,
      publicReadProjectSlug: null,
      publicReadProjectName: null
    })).toThrow('Smoke field name must not be blank.');
  });

  it('rejects using the managed id column for smoke writes', () => {
    expect(() => buildSetupConfigFromAnswers({
      profile: 'local',
      deployAdmin: true,
      spreadsheetIdOrUrl: 'sheet-1',
      privateProjectSlug: 'demo',
      privateProjectName: 'Demo',
      privateTableSlug: 'users',
      privateSheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['email'],
      cacheTtlSeconds: 60,
      smokeFieldName: '_id',
      smokeCreateValue: 'Smoke Row',
      smokeUpdateValue: 'Smoke Row Updated',
      addPublicReadProject: false,
      publicReadProjectSlug: null,
      publicReadProjectName: null
    })).toThrow('Smoke field name must not use the managed ID column.');
  });
});
