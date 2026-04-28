import { createProjectInputSchema, createTableInputSchema, adminCreateApiKeyInputSchema } from '@sheetflare/contracts';
import { ScriptError } from './runtime';

type BootstrapTable = {
  tableSlug: string;
  sheetTabName: string;
  sheetGid?: number | undefined;
  idColumn?: string | undefined;
  indexedFields?: string[] | undefined;
  fieldRules?: Record<string, unknown> | undefined;
  headerRow?: number | undefined;
  dataStartRow?: number | undefined;
  readEnabled?: boolean | undefined;
  createEnabled?: boolean | undefined;
  updateEnabled?: boolean | undefined;
  deleteEnabled?: boolean | undefined;
  cacheTtlSeconds?: number | undefined;
};

type BootstrapProject = {
  slug: string;
  name: string;
  spreadsheetId: string;
  googleCredentialRef?: string | undefined;
  defaultAuthMode?: 'private' | 'public-read' | undefined;
  tables?: BootstrapTable[] | undefined;
};

type BootstrapApiKey = {
  name: string;
  projectSlug?: string | null | undefined;
  scopes: string[];
};

export type BootstrapConfig = {
  projects: BootstrapProject[];
  apiKeys?: BootstrapApiKey[] | undefined;
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

function parseTables(project: Record<string, unknown>, projectIndex: number) {
  const rawTables = project.tables;
  if (rawTables === undefined) {
    return undefined;
  }

  if (!Array.isArray(rawTables)) {
    throw new ScriptError(`Bootstrap config project ${projectIndex + 1} has invalid tables: expected an array.`);
  }

  return rawTables.map((table, tableIndex) => {
    try {
      return createTableInputSchema.parse(table);
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        throw new ScriptError(
          `Bootstrap config project ${projectIndex + 1} table ${tableIndex + 1} is invalid: ${formatZodError(error as { issues: Array<{ path: Array<string | number>; message: string }> })}`
        );
      }

      throw error;
    }
  });
}

export function parseBootstrapConfig(input: unknown): BootstrapConfig {
  if (!isRecord(input)) {
    throw new ScriptError('SHEETFLARE_BOOTSTRAP_CONFIG_JSON must be a JSON object.');
  }

  if (!Array.isArray(input.projects) || input.projects.length === 0) {
    throw new ScriptError('SHEETFLARE_BOOTSTRAP_CONFIG_JSON must include at least one project.');
  }

  const projects = input.projects.map((project, projectIndex) => {
    if (!isRecord(project)) {
      throw new ScriptError(`Bootstrap config project ${projectIndex + 1} must be an object.`);
    }

    try {
      return {
        ...createProjectInputSchema.parse(project),
        ...(project.tables !== undefined ? { tables: parseTables(project, projectIndex) } : {})
      };
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        throw new ScriptError(
          `Bootstrap config project ${projectIndex + 1} is invalid: ${formatZodError(error as { issues: Array<{ path: Array<string | number>; message: string }> })}`
        );
      }

      throw error;
    }
  });

  if (input.apiKeys === undefined) {
    return { projects };
  }

  if (!Array.isArray(input.apiKeys)) {
    throw new ScriptError('SHEETFLARE_BOOTSTRAP_CONFIG_JSON field apiKeys must be an array when provided.');
  }

  const apiKeys = input.apiKeys.map((apiKey, apiKeyIndex) => {
    try {
      return adminCreateApiKeyInputSchema.parse(apiKey);
    } catch (error) {
      if (error instanceof Error && 'issues' in error) {
        throw new ScriptError(
          `Bootstrap config api key ${apiKeyIndex + 1} is invalid: ${formatZodError(error as { issues: Array<{ path: Array<string | number>; message: string }> })}`
        );
      }

      throw error;
    }
  });

  return {
    projects,
    apiKeys
  };
}
