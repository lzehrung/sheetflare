import {
  createProjectInputSchema,
  createTableInputSchema,
  type CreateProjectInput,
  type CreateTableInput,
  projectSlugSchema,
  tableSlugSchema
} from '@sheetflare/contracts';
import { ScriptError } from './runtime';

type SetupProjectSection = Omit<CreateProjectInput, 'defaultAuthMode'> & {
  tables: CreateTableInput[];
};

type SetupSmokeConfig = {
  enabled: boolean;
  privateTableSlug: string;
  publicTableSlug?: string | null;
  adminKeyName: string;
  privateReadKeyName: string;
  mutationKeyName: string;
  createValues: Record<string, unknown>;
  updateValues: Record<string, unknown>;
};

export type SetupConfig = {
  profile: string;
  deploy: {
    api: boolean;
    admin: boolean;
  };
  privateProject: SetupProjectSection;
  publicReadProject: SetupProjectSection | null;
  smoke: SetupSmokeConfig;
};

function describePath(path: Array<string | number>) {
  return path.length === 0 ? 'value' : path.join('.');
}

function formatZodError(error: { issues: Array<{ path: Array<string | number>; message: string }> }) {
  return error.issues.map((issue) => `${describePath(issue.path)}: ${issue.message}`).join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.getPrototypeOf(value) === Object.prototype;
}

function parseProjectSection(input: unknown, label: 'privateProject' | 'publicReadProject'): SetupProjectSection {
  if (!isRecord(input)) {
    throw new ScriptError(`${label} must be an object.`);
  }

  const { tables, ...projectFields } = input;
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new ScriptError(`${label}.tables must include at least one table.`);
  }

  let project: Omit<CreateProjectInput, 'defaultAuthMode'>;
  try {
    const parsedProject = createProjectInputSchema.parse(projectFields);
    const { defaultAuthMode, ...withoutAuthMode } = parsedProject;
    void defaultAuthMode;
    project = withoutAuthMode;
  } catch (error) {
    if (error instanceof Error && 'issues' in error) {
      throw new ScriptError(`${label} is invalid: ${formatZodError(error as { issues: Array<{ path: Array<string | number>; message: string }> })}`);
    }

    throw error;
  }

  const parsedTables = tables.map((table, tableIndex) => {
    try {
      return createTableInputSchema.parse(table);
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        throw new ScriptError(`${label}.tables.${tableIndex + 1} is invalid: ${formatZodError(error as { issues: Array<{ path: Array<string | number>; message: string }> })}`);
      }

      throw error;
    }
  });

  return {
    ...project,
    tables: parsedTables
  };
}

function parseRequiredString(input: unknown, path: string) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ScriptError(`${path} must be a non-empty string.`);
  }

  return input.trim();
}

function parseBoolean(input: unknown, path: string) {
  if (typeof input !== 'boolean') {
    throw new ScriptError(`${path} must be a boolean.`);
  }

  return input;
}

function parseRowValues(input: unknown, path: string) {
  if (!isPlainRecord(input) || Object.keys(input).length === 0) {
    throw new ScriptError(`${path} must be a non-empty JSON object.`);
  }

  return input;
}

function assertKeyNamesAreDistinct(smoke: Pick<SetupSmokeConfig, 'adminKeyName' | 'privateReadKeyName' | 'mutationKeyName'>) {
  const uniqueNames = new Set([smoke.adminKeyName, smoke.privateReadKeyName, smoke.mutationKeyName]);
  if (uniqueNames.size !== 3) {
    throw new ScriptError('smoke adminKeyName, privateReadKeyName, and mutationKeyName must be distinct.');
  }
}

function assertTableSlugExists(project: SetupProjectSection, tableSlug: string, path: string) {
  if (!project.tables.some((table) => table.tableSlug === tableSlug)) {
    throw new ScriptError(`${path} must reference a configured table slug in ${project.slug}.`);
  }
}

function findTable(project: SetupProjectSection, tableSlug: string) {
  const table = project.tables.find((entry) => entry.tableSlug === tableSlug);
  if (!table) {
    throw new ScriptError(`Configured table ${tableSlug} was not found in ${project.slug}.`);
  }

  return table;
}

function assertSmokeKeysAreWritable(
  project: SetupProjectSection,
  tableSlug: string,
  values: Record<string, unknown>,
  path: string
) {
  const table = findTable(project, tableSlug);
  const idColumn = table.idColumn ?? '_id';
  if (Object.prototype.hasOwnProperty.call(values, idColumn)) {
    throw new ScriptError(`${path} must not write the managed ID column ${idColumn}.`);
  }

  for (const fieldName of table.readOnlyFields ?? []) {
    if (Object.prototype.hasOwnProperty.call(values, fieldName)) {
      throw new ScriptError(`${path} must not write read-only field ${fieldName}.`);
    }
  }
}

export function parseSpreadsheetId(input: string) {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ScriptError('Spreadsheet ID or URL must not be blank.');
  }

  const spreadsheetUrlPattern = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/?#]+)(?:[/?#].*)?$/i;
  const match = spreadsheetUrlPattern.exec(trimmed);
  if (match?.[1]) {
    return match[1];
  }

  if (/^https?:\/\//i.test(trimmed)) {
    throw new ScriptError('Spreadsheet URL must look like https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/...');
  }

  return trimmed;
}

export function serializeSetupConfig(config: SetupConfig) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function createDefaultSetupConfig() {
  return serializeSetupConfig({
    profile: 'local',
    deploy: {
      api: true,
      admin: true
    },
    privateProject: {
      slug: 'demo',
      name: 'Demo',
      spreadsheetId: '<SPREADSHEET_ID>',
      googleCredentialRef: 'default',
      tables: [
        {
          tableSlug: 'users',
          sheetTabName: 'Users',
          idColumn: '_id',
          indexedFields: ['name', 'status'],
          cacheTtlSeconds: 60
        }
      ]
    },
    publicReadProject: null,
    smoke: {
      enabled: true,
      privateTableSlug: 'users',
      publicTableSlug: null,
      adminKeyName: 'demo-admin',
      privateReadKeyName: 'demo-read',
      mutationKeyName: 'demo-mutation',
      createValues: {
        name: 'Smoke Row',
        status: 'active'
      },
      updateValues: {
        status: 'inactive'
      }
    }
  });
}

export function parseSetupConfig(input: unknown): SetupConfig {
  if (!isRecord(input)) {
    throw new ScriptError('Setup config must be a JSON object.');
  }

  const profile = parseRequiredString(input.profile, 'profile');

  if (!isRecord(input.deploy)) {
    throw new ScriptError('deploy must be an object.');
  }

  const deploy = {
    api: parseBoolean(input.deploy.api, 'deploy.api'),
    admin: parseBoolean(input.deploy.admin, 'deploy.admin')
  };

  const privateProject = parseProjectSection(input.privateProject, 'privateProject');
  const publicReadProject = input.publicReadProject === undefined || input.publicReadProject === null
    ? null
    : parseProjectSection(input.publicReadProject, 'publicReadProject');

  if (publicReadProject && publicReadProject.slug === privateProject.slug) {
    throw new ScriptError('publicReadProject.slug must differ from privateProject.slug.');
  }

  if (!isRecord(input.smoke)) {
    throw new ScriptError('smoke must be an object.');
  }

  const privateTableSlug = tableSlugSchema.parse(parseRequiredString(input.smoke.privateTableSlug, 'smoke.privateTableSlug'));
  const publicTableSlug = input.smoke.publicTableSlug === undefined || input.smoke.publicTableSlug === null
    ? null
    : tableSlugSchema.parse(parseRequiredString(input.smoke.publicTableSlug, 'smoke.publicTableSlug'));
  const smoke: SetupSmokeConfig = {
    enabled: parseBoolean(input.smoke.enabled, 'smoke.enabled'),
    privateTableSlug,
    publicTableSlug,
    adminKeyName: parseRequiredString(input.smoke.adminKeyName, 'smoke.adminKeyName'),
    privateReadKeyName: parseRequiredString(input.smoke.privateReadKeyName, 'smoke.privateReadKeyName'),
    mutationKeyName: parseRequiredString(input.smoke.mutationKeyName, 'smoke.mutationKeyName'),
    createValues: parseRowValues(input.smoke.createValues, 'smoke.createValues'),
    updateValues: parseRowValues(input.smoke.updateValues, 'smoke.updateValues')
  };

  assertKeyNamesAreDistinct(smoke);
  assertTableSlugExists(privateProject, smoke.privateTableSlug, 'smoke.privateTableSlug');
  assertSmokeKeysAreWritable(privateProject, smoke.privateTableSlug, smoke.createValues, 'smoke.createValues');
  assertSmokeKeysAreWritable(privateProject, smoke.privateTableSlug, smoke.updateValues, 'smoke.updateValues');

  if (smoke.publicTableSlug && !publicReadProject) {
    throw new ScriptError('smoke.publicTableSlug requires publicReadProject to be configured.');
  }

  if (publicReadProject && smoke.publicTableSlug) {
    assertTableSlugExists(publicReadProject, smoke.publicTableSlug, 'smoke.publicTableSlug');
  }

  if (!publicReadProject && smoke.publicTableSlug !== null) {
    throw new ScriptError('smoke.publicTableSlug must be null when publicReadProject is not configured.');
  }

  if (publicReadProject && smoke.publicTableSlug === null) {
    throw new ScriptError('smoke.publicTableSlug must be set when publicReadProject is configured.');
  }

  return {
    profile,
    deploy,
    privateProject,
    publicReadProject,
    smoke
  };
}

export function normalizeSpreadsheetId(value: string) {
  return createProjectInputSchema.shape.spreadsheetId.parse(parseSpreadsheetId(value));
}

export function normalizeProjectSlug(value: string) {
  return projectSlugSchema.parse(parseRequiredString(value, 'project slug'));
}

export function normalizeTableSlug(value: string) {
  return tableSlugSchema.parse(parseRequiredString(value, 'table slug'));
}
