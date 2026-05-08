import { describe, expect, it } from 'vitest';
import {
  buildBeginnerSetupConfigFromAnswers,
  buildSetupConfigFromAnswers,
  confirmSheetShared,
  promptForSetup,
  type SetupPrompter
} from './setup-prompts';

function createFakePrompter(options: {
  textResponses: string[];
  confirmResponses?: boolean[];
}) {
  const textPrompts: Array<{ message: string; defaultValue?: string }> = [];
  const confirmPrompts: Array<{ message: string; defaultValue: boolean }> = [];
  const textResponses = [...options.textResponses];
  const confirmResponses = [...(options.confirmResponses ?? [])];
  const prompter: SetupPrompter = {
    async text(prompt) {
      textPrompts.push({
        message: prompt.message,
        ...(prompt.defaultValue !== undefined ? { defaultValue: prompt.defaultValue } : {})
      });
      const response = textResponses.shift();
      if (response === undefined) {
        throw new Error(`Missing fake text response for ${prompt.message}`);
      }
      const error = prompt.validate?.(response) ?? null;
      if (error) {
        throw new Error(error);
      }
      return response;
    },
    async confirm(prompt) {
      confirmPrompts.push(prompt);
      const response = confirmResponses.shift();
      if (response === undefined) {
        throw new Error(`Missing fake confirm response for ${prompt.message}`);
      }
      return response;
    }
  };

  return {
    prompter,
    textPrompts,
    confirmPrompts
  };
}

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

describe('promptForSetup', () => {
  it('asks only beginner questions and enables all setup actions by default', async () => {
    const { prompter, textPrompts, confirmPrompts } = createFakePrompter({
      textResponses: ['sheet-1', 'Users', 'name'],
      confirmResponses: [true]
    });

    const result = await promptForSetup(prompter, {
      mode: 'beginner',
      googleCredentialAvailable: false
    });

    expect(textPrompts).toEqual([
      { message: 'Google Sheet URL or spreadsheet ID' },
      { message: 'Existing Google Sheets tab name', defaultValue: 'Sheet1' },
      { message: 'Writable sheet column to use for setup validation' }
    ]);
    expect(confirmPrompts).toEqual([
      {
        message: 'Set up Google credentials automatically with gcloud',
        defaultValue: true
      }
    ]);
    expect(result.actions).toEqual({
      applySecretsNow: true,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true,
      verifyNow: true
    });
    expect(result.provisionGoogle).toBe(true);
    expect(result.config.profile).toBe('production');
    expect(result.config.privateProject.tables[0]?.tableSlug).toBe('users');
  });

  it('does not ask about Google provisioning when credentials are already available', async () => {
    const { prompter, confirmPrompts } = createFakePrompter({
      textResponses: ['sheet-1', 'Users', 'name']
    });

    const result = await promptForSetup(prompter, {
      mode: 'beginner',
      googleCredentialAvailable: true
    });

    expect(confirmPrompts).toEqual([]);
    expect(result.provisionGoogle).toBe(false);
  });

  it('does not ask about Google provisioning when the CLI already requested it', async () => {
    const { prompter, confirmPrompts } = createFakePrompter({
      textResponses: ['sheet-1', 'Users', 'name']
    });

    const result = await promptForSetup(prompter, {
      mode: 'beginner',
      googleCredentialAvailable: false,
      provisionGoogleRequested: true
    });

    expect(confirmPrompts).toEqual([]);
    expect(result.provisionGoogle).toBe(true);
  });

  it('preserves the advanced setup prompt actions', async () => {
    const { prompter } = createFakePrompter({
      textResponses: [
        'local',
        'sheet-1',
        'demo',
        'Demo',
        'users',
        'Users',
        '_id',
        'email,status',
        '60',
        'email',
        'Smoke Row',
        'Smoke Row Updated'
      ],
      confirmResponses: [true, false, true, false, true, false]
    });

    const result = await promptForSetup(prompter, {
      mode: 'advanced',
      googleCredentialAvailable: false
    });

    expect(result.actions).toEqual({
      applySecretsNow: true,
      deployNow: false,
      bootstrapNow: true,
      smokeNow: false,
      verifyNow: false
    });
    expect(result.provisionGoogle).toBe(false);
    expect(result.config.privateProject.slug).toBe('demo');
  });
});

describe('confirmSheetShared', () => {
  it('continues when the operator confirms sheet sharing', async () => {
    const { prompter, confirmPrompts } = createFakePrompter({
      textResponses: [],
      confirmResponses: [true]
    });

    await expect(confirmSheetShared(prompter)).resolves.toBeUndefined();
    expect(confirmPrompts).toEqual([
      {
        message: 'Continue after sharing the sheet with the service account',
        defaultValue: true
      }
    ]);
  });

  it('stops with a rerun command when the sheet is not shared yet', async () => {
    const { prompter } = createFakePrompter({
      textResponses: [],
      confirmResponses: [false]
    });

    await expect(confirmSheetShared(prompter)).rejects.toThrow(
      'Share the sheet with the service-account email as Editor, then rerun npm run setup -- --bootstrap --smoke --verify.'
    );
  });
});
