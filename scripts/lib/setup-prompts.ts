import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  normalizeSpreadsheetId,
  normalizeProjectSlug,
  normalizeTableSlug,
  parseSetupConfig,
  type SetupConfig
} from './setup-config';
import { ScriptError } from './runtime';

export type SetupAnswers = {
  profile: string;
  deployAdmin: boolean;
  spreadsheetIdOrUrl: string;
  privateProjectSlug: string;
  privateProjectName: string;
  privateTableSlug: string;
  privateSheetTabName: string;
  idColumn: string;
  indexedFields: string[];
  cacheTtlSeconds: number;
  smokeFieldName: string;
  smokeCreateValue: string;
  smokeUpdateValue: string;
  addPublicReadProject: boolean;
  publicReadProjectSlug: string | null;
  publicReadProjectName: string | null;
};

export type BeginnerSetupAnswers = {
  spreadsheetIdOrUrl: string;
  sheetTabName: string;
  smokeFieldName: string;
};

export type SetupPromptActions = {
  applySecretsNow: boolean;
  deployNow: boolean;
  bootstrapNow: boolean;
  smokeNow: boolean;
  verifyNow: boolean;
};

export type SetupPromptMode = 'beginner' | 'advanced';

export type SetupPromptResult = {
  config: SetupConfig;
  actions: SetupPromptActions;
  provisionGoogle: boolean;
};

export type SetupPromptOptions = {
  mode: SetupPromptMode;
  googleCredentialAvailable: boolean;
};

export type SetupPrompter = {
  text: (options: { message: string; defaultValue?: string; validate?: (value: string) => string | null }) => Promise<string>;
  confirm: (options: { message: string; defaultValue: boolean }) => Promise<boolean>;
  close?: () => void;
};

export async function confirmSheetShared(prompter: SetupPrompter) {
  const confirmed = await prompter.confirm({
    message: 'Continue after sharing the sheet with the service account',
    defaultValue: true
  });
  if (!confirmed) {
    throw new ScriptError(
      'Share the sheet with the service-account email as Editor, then rerun npm run setup -- --bootstrap --smoke --verify.'
    );
  }
}

function splitCommaSeparatedList(input: string) {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string, path: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ScriptError(`${path} must be a positive integer.`);
  }

  return parsed;
}

function titleCaseSlug(slug: string) {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function selectDefaultSmokeField(options: {
  idColumn: string;
  indexedFields: string[];
}) {
  return options.indexedFields.find((fieldName) => fieldName.trim() !== '' && fieldName.trim() !== options.idColumn.trim());
}

function assertSmokeFieldNameIsWritable(smokeFieldName: string, idColumn: string) {
  const trimmed = smokeFieldName.trim();
  if (trimmed.length === 0) {
    throw new ScriptError('Smoke field name must not be blank.');
  }
  if (trimmed === idColumn.trim()) {
    throw new ScriptError('Smoke field name must not use the managed ID column.');
  }

  return trimmed;
}

function deriveTableSlugFromTabName(sheetTabName: string) {
  const derived = sheetTabName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalizeTableSlug(derived.length > 0 ? derived : 'table');
}

export function buildBeginnerSetupConfigFromAnswers(answers: BeginnerSetupAnswers): SetupConfig {
  const spreadsheetId = normalizeSpreadsheetId(answers.spreadsheetIdOrUrl);
  const sheetTabName = answers.sheetTabName.trim();
  if (sheetTabName.length === 0) {
    throw new ScriptError('Sheet tab name must not be blank.');
  }

  const tableSlug = deriveTableSlugFromTabName(sheetTabName);
  const idColumn = '_id';
  const smokeFieldName = assertSmokeFieldNameIsWritable(answers.smokeFieldName, idColumn);

  return parseSetupConfig({
    profile: 'production',
    deploy: {
      api: true,
      admin: true
    },
    privateProject: {
      slug: 'main',
      name: 'Main',
      spreadsheetId,
      googleCredentialRef: 'default',
      tables: [
        {
          tableSlug,
          sheetTabName,
          idColumn,
          cacheTtlSeconds: 60
        }
      ]
    },
    publicReadProject: null,
    smoke: {
      enabled: true,
      privateTableSlug: tableSlug,
      publicTableSlug: null,
      adminKeyName: 'main-admin',
      privateReadKeyName: 'main-read',
      mutationKeyName: 'main-mutation',
      createValues: {
        [smokeFieldName]: 'Sheetflare smoke row'
      },
      updateValues: {
        [smokeFieldName]: 'Sheetflare smoke row updated'
      }
    }
  });
}

export function buildSetupConfigFromAnswers(answers: SetupAnswers): SetupConfig {
  const privateProjectSlug = normalizeProjectSlug(answers.privateProjectSlug);
  const privateTableSlug = normalizeTableSlug(answers.privateTableSlug);
  const idColumn = answers.idColumn.trim();
  const smokeFieldName = assertSmokeFieldNameIsWritable(answers.smokeFieldName, idColumn);

  const spreadsheetId = normalizeSpreadsheetId(answers.spreadsheetIdOrUrl);
  const indexedFields = Array.from(new Set(splitCommaSeparatedList(answers.indexedFields.join(','))));
  const publicReadProject = answers.addPublicReadProject
    ? {
        slug: normalizeProjectSlug(answers.publicReadProjectSlug ?? `${privateProjectSlug}-public`),
        name: (answers.publicReadProjectName ?? `${answers.privateProjectName} Public`).trim(),
        spreadsheetId,
        googleCredentialRef: 'default',
        tables: [
          {
            tableSlug: privateTableSlug,
            sheetTabName: answers.privateSheetTabName.trim(),
            idColumn,
            ...(indexedFields.length > 0 ? { indexedFields } : {}),
            cacheTtlSeconds: answers.cacheTtlSeconds
          }
        ]
      }
    : null;

  return parseSetupConfig({
    profile: answers.profile.trim(),
    deploy: {
      api: true,
      admin: answers.deployAdmin
    },
    privateProject: {
      slug: privateProjectSlug,
      name: answers.privateProjectName.trim(),
      spreadsheetId,
      googleCredentialRef: 'default',
      tables: [
        {
          tableSlug: privateTableSlug,
          sheetTabName: answers.privateSheetTabName.trim(),
          idColumn,
          ...(indexedFields.length > 0 ? { indexedFields } : {}),
          cacheTtlSeconds: answers.cacheTtlSeconds
        }
      ]
    },
    publicReadProject,
    smoke: {
      enabled: true,
      privateTableSlug,
      publicTableSlug: publicReadProject ? privateTableSlug : null,
      adminKeyName: `${privateProjectSlug}-admin`,
      privateReadKeyName: `${privateProjectSlug}-read`,
      mutationKeyName: `${privateProjectSlug}-mutation`,
      createValues: {
        [smokeFieldName]: answers.smokeCreateValue
      },
      updateValues: {
        [smokeFieldName]: answers.smokeUpdateValue
      }
    }
  });
}

async function promptForBeginnerSetup(
  prompter: SetupPrompter,
  options: Pick<SetupPromptOptions, 'googleCredentialAvailable'>
): Promise<SetupPromptResult> {
  const spreadsheetIdOrUrl = await prompter.text({
    message: 'Google Sheet URL or spreadsheet ID',
    validate: (value) => {
      try {
        normalizeSpreadsheetId(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const sheetTabName = await prompter.text({
    message: 'Existing Google Sheets tab name',
    defaultValue: 'Sheet1',
    validate: (value) => value.trim().length > 0 ? null : 'Sheet tab name must not be blank.'
  });
  const smokeFieldName = await prompter.text({
    message: 'Writable sheet column to use for setup validation',
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Smoke field name must not be blank.';
      }
      if (trimmed === '_id') {
        return 'Smoke field name must not use the managed ID column.';
      }
      return null;
    }
  });
  const provisionGoogle = options.googleCredentialAvailable
    ? false
    : await prompter.confirm({
        message: 'Set up Google credentials automatically with gcloud',
        defaultValue: true
      });

  return {
    config: buildBeginnerSetupConfigFromAnswers({
      spreadsheetIdOrUrl,
      sheetTabName,
      smokeFieldName
    }),
    actions: {
      applySecretsNow: true,
      deployNow: true,
      bootstrapNow: true,
      smokeNow: true,
      verifyNow: true
    },
    provisionGoogle
  };
}

export async function promptForAdvancedSetup(prompter: SetupPrompter): Promise<SetupPromptResult> {
  const profile = await prompter.text({
    message: 'Setup profile',
    defaultValue: 'local',
    validate: (value) => value.trim().length > 0 ? null : 'Profile must not be blank.'
  });
  const deployAdmin = await prompter.confirm({
    message: 'Configure admin UI deploy now',
    defaultValue: true
  });
  const spreadsheetIdOrUrl = await prompter.text({
    message: 'Google Sheet URL or spreadsheet ID',
    validate: (value) => {
      try {
        normalizeSpreadsheetId(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const privateProjectSlug = await prompter.text({
    message: 'Private project slug',
    defaultValue: 'demo',
    validate: (value) => {
      try {
        normalizeProjectSlug(value);
        return null;
      } catch {
        return 'Project slug must use lowercase letters, numbers, and single hyphens.';
      }
    }
  });
  const privateProjectName = await prompter.text({
    message: 'Private project name',
    defaultValue: titleCaseSlug(privateProjectSlug)
  });
  const privateTableSlug = await prompter.text({
    message: 'First table slug',
    defaultValue: 'users',
    validate: (value) => {
      try {
        normalizeTableSlug(value);
        return null;
      } catch {
        return 'Table slug must use lowercase letters, numbers, and single hyphens.';
      }
    }
  });
  const privateSheetTabName = await prompter.text({
    message: 'Existing Google Sheets tab name',
    defaultValue: 'Users',
    validate: (value) => value.trim().length > 0 ? null : 'Sheet tab name must not be blank.'
  });
  const idColumn = await prompter.text({
    message: 'Managed ID column',
    defaultValue: '_id',
    validate: (value) => value.trim().length > 0 ? null : 'ID column must not be blank.'
  });
  const indexedFieldsRaw = await prompter.text({
    message: 'Additional indexed fields (comma-separated, optional)',
    defaultValue: ''
  });
  const cacheTtlRaw = await prompter.text({
    message: 'Cache TTL in seconds',
    defaultValue: '60',
    validate: (value) => {
      try {
        parsePositiveInteger(value, 'Cache TTL');
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  });
  const indexedFields = splitCommaSeparatedList(indexedFieldsRaw);
  const defaultSmokeField = selectDefaultSmokeField({
    idColumn,
    indexedFields
  });
  const smokeFieldName = await prompter.text({
    message: 'Writable sheet column to use for smoke create/update checks',
    ...(defaultSmokeField ? { defaultValue: defaultSmokeField } : {}),
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Smoke field name must not be blank.';
      }
      if (trimmed === idColumn.trim()) {
        return 'Smoke field name must not use the managed ID column.';
      }
      return null;
    }
  });
  const smokeCreateValue = await prompter.text({
    message: 'Smoke create value',
    defaultValue: 'Smoke Row',
    validate: (value) => value.trim().length > 0 ? null : 'Smoke create value must not be blank.'
  });
  const smokeUpdateValue = await prompter.text({
    message: 'Smoke update value',
    defaultValue: 'Smoke Row Updated',
    validate: (value) => value.trim().length > 0 ? null : 'Smoke update value must not be blank.'
  });
  const addPublicReadProject = await prompter.confirm({
    message: 'Add an optional public-read project using the same spreadsheet and table mapping',
    defaultValue: false
  });
  const publicReadProjectSlug = addPublicReadProject
    ? await prompter.text({
        message: 'Public-read project slug',
        defaultValue: `${privateProjectSlug}-public`,
        validate: (value) => {
          try {
            normalizeProjectSlug(value);
            return null;
          } catch {
            return 'Project slug must use lowercase letters, numbers, and single hyphens.';
          }
        }
      })
    : null;
  const publicReadProjectName = addPublicReadProject
    ? await prompter.text({
        message: 'Public-read project name',
        defaultValue: `${privateProjectName} Public`
      })
    : null;

  const config = buildSetupConfigFromAnswers({
    profile,
    deployAdmin,
    spreadsheetIdOrUrl,
    privateProjectSlug,
    privateProjectName,
    privateTableSlug,
    privateSheetTabName,
    idColumn,
    indexedFields,
    cacheTtlSeconds: parsePositiveInteger(cacheTtlRaw, 'Cache TTL'),
    smokeFieldName,
    smokeCreateValue,
    smokeUpdateValue,
    addPublicReadProject,
    publicReadProjectSlug,
    publicReadProjectName
  });

  const applySecretsNow = await prompter.confirm({
    message: 'Apply Worker secrets now',
    defaultValue: true
  });
  const deployNow = await prompter.confirm({
    message: 'Deploy now after writing config',
    defaultValue: true
  });
  const bootstrapNow = await prompter.confirm({
    message: 'Bootstrap projects and keys after deploy',
    defaultValue: true
  });
  const smokeNow = await prompter.confirm({
    message: 'Run smoke validation after bootstrap',
    defaultValue: true
  });

  return {
    config,
    actions: {
      applySecretsNow,
      deployNow,
      bootstrapNow,
      smokeNow,
      verifyNow: false
    },
    provisionGoogle: false
  };
}

export async function promptForSetup(
  prompter: SetupPrompter,
  options: SetupPromptOptions = { mode: 'advanced', googleCredentialAvailable: false }
): Promise<SetupPromptResult> {
  if (options.mode === 'beginner') {
    return promptForBeginnerSetup(prompter, options);
  }

  return promptForAdvancedSetup(prompter);
}

export function createConsolePrompter(): SetupPrompter {
  const readline = createInterface({
    input,
    output
  });

  async function text(options: { message: string; defaultValue?: string; validate?: (value: string) => string | null }) {
    while (true) {
      const suffix = options.defaultValue !== undefined ? ` [${options.defaultValue}]` : '';
      const response = await readline.question(`${options.message}${suffix}: `);
      const value = response.trim().length === 0 && options.defaultValue !== undefined
        ? options.defaultValue
        : response;
      const error = options.validate?.(value) ?? null;
      if (!error) {
        return value;
      }

      output.write(`${error}\n`);
    }
  }

  async function confirm(options: { message: string; defaultValue: boolean }) {
    const defaultLabel = options.defaultValue ? 'Y/n' : 'y/N';
    while (true) {
      const response = await readline.question(`${options.message} [${defaultLabel}]: `);
      const normalized = response.trim().toLowerCase();
      if (normalized.length === 0) {
        return options.defaultValue;
      }
      if (normalized === 'y' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'n' || normalized === 'no') {
        return false;
      }

      output.write('Enter yes or no.\n');
    }
  }

  return {
    text,
    confirm,
    close: () => {
      readline.close();
    }
  };
}
