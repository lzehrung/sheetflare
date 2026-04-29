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

export type SetupPromptActions = {
  applySecretsNow: boolean;
  deployNow: boolean;
  bootstrapNow: boolean;
  smokeNow: boolean;
};

export type SetupPromptResult = {
  config: SetupConfig;
  actions: SetupPromptActions;
};

export type SetupPrompter = {
  text: (options: { message: string; defaultValue?: string; validate?: (value: string) => string | null }) => Promise<string>;
  confirm: (options: { message: string; defaultValue: boolean }) => Promise<boolean>;
  close?: () => void;
};

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

export function buildSetupConfigFromAnswers(answers: SetupAnswers): SetupConfig {
  const privateProjectSlug = normalizeProjectSlug(answers.privateProjectSlug);
  const privateTableSlug = normalizeTableSlug(answers.privateTableSlug);
  const smokeFieldName = answers.smokeFieldName.trim();
  if (smokeFieldName.length === 0) {
    throw new ScriptError('Smoke field name must not be blank.');
  }

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
            idColumn: answers.idColumn.trim(),
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
          idColumn: answers.idColumn.trim(),
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

export async function promptForSetup(prompter: SetupPrompter): Promise<SetupPromptResult> {
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
  const defaultSmokeField = splitCommaSeparatedList(indexedFieldsRaw)[0] ?? 'name';
  const smokeFieldName = await prompter.text({
    message: 'Writable field to use for smoke checks',
    defaultValue: defaultSmokeField,
    validate: (value) => value.trim().length > 0 ? null : 'Smoke field name must not be blank.'
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
    indexedFields: splitCommaSeparatedList(indexedFieldsRaw),
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
      smokeNow
    }
  };
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
