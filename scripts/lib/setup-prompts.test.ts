import { describe, expect, it } from 'vitest';
import { buildSetupConfigFromAnswers } from './setup-prompts';

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
});
