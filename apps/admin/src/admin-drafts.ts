import {
  adminCreateApiKeyInputSchema,
  createProjectInputSchema,
  createTableInputSchema,
  slugPattern,
  type AdminCreateApiKeyInput,
  type ApiScope,
  type CreateProjectInput,
  type CreateTableInput
} from '@sheetflare/contracts';

export type CreateProjectDraft = {
  slug: string;
  name: string;
  spreadsheetId: string;
  googleCredentialRef: string;
  defaultAuthMode: 'private' | 'public-read';
};

export type CreateTableDraft = {
  tableSlug: string;
  sheetTabName: string;
  sheetGid: string;
  idColumn: string;
  indexedFields: string;
  headerRow: string;
  dataStartRow: string;
  cacheTtlSeconds: string;
  readEnabled: boolean;
  createEnabled: boolean;
  updateEnabled: boolean;
  deleteEnabled: boolean;
};

export type CreateKeyDraft = {
  name: string;
  projectScoped: boolean;
  scopes: ApiScope[];
};

export type DraftValidation<T, FieldName extends string> = {
  value: T | null;
  fieldErrors: Partial<Record<FieldName | 'form', string>>;
  isValid: boolean;
};

export const allScopes: ApiScope[] = [
  'admin:projects',
  'admin:keys',
  'table:read',
  'table:create',
  'table:update',
  'table:delete'
];

export const initialCreateProjectDraft: CreateProjectDraft = {
  slug: '',
  name: '',
  spreadsheetId: '',
  googleCredentialRef: '',
  defaultAuthMode: 'private'
};

export const initialCreateTableDraft: CreateTableDraft = {
  tableSlug: '',
  sheetTabName: '',
  sheetGid: '',
  idColumn: '_id',
  indexedFields: 'name,status',
  headerRow: '1',
  dataStartRow: '2',
  cacheTtlSeconds: '15',
  readEnabled: true,
  createEnabled: true,
  updateEnabled: true,
  deleteEnabled: true
};

export const initialCreateKeyDraft: CreateKeyDraft = {
  name: 'ops-key',
  projectScoped: true,
  scopes: ['admin:projects', 'admin:keys', 'table:read']
};

type ProjectFieldName = keyof CreateProjectDraft;
type TableFieldName = keyof CreateTableDraft;
type KeyFieldName = 'name' | 'projectScoped' | 'scopes';

function isIntegerString(value: string) {
  return /^[0-9]+$/.test(value);
}

function parsePositiveInteger(value: string, fieldLabel: string) {
  const normalized = value.trim();
  if (!isIntegerString(normalized)) {
    return {
      value: null,
      error: `${fieldLabel} must be a positive integer.`
    };
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      value: null,
      error: `${fieldLabel} must be a positive integer.`
    };
  }

  return {
    value: parsed,
    error: null
  };
}

function parseNonNegativeInteger(value: string, fieldLabel: string) {
  const normalized = value.trim();
  if (!isIntegerString(normalized)) {
    return {
      value: null,
      error: `${fieldLabel} must be a non-negative integer.`
    };
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return {
      value: null,
      error: `${fieldLabel} must be a non-negative integer.`
    };
  }

  return {
    value: parsed,
    error: null
  };
}

function collectSchemaErrors<FieldName extends string>(
  fieldErrors: Partial<Record<FieldName | 'form', string>>,
  issues: { path: PropertyKey[]; message: string }[]
) {
  for (const issue of issues) {
    const path = issue.path[0];
    if (typeof path === 'string' && !(path in fieldErrors)) {
      fieldErrors[path as FieldName] = issue.message;
      continue;
    }

    if (!fieldErrors.form) {
      fieldErrors.form = issue.message;
    }
  }
}

export function validateCreateProjectDraft(
  draft: CreateProjectDraft
): DraftValidation<CreateProjectInput, ProjectFieldName> {
  const fieldErrors: Partial<Record<ProjectFieldName | 'form', string>> = {};
  const slug = draft.slug.trim();
  const name = draft.name.trim();
  const spreadsheetId = draft.spreadsheetId.trim();
  const googleCredentialRef = draft.googleCredentialRef.trim();

  if (slug.length === 0) {
    fieldErrors.slug = 'Slug is required.';
  } else if (!slugPattern.test(slug)) {
    fieldErrors.slug = 'Use lowercase letters, numbers, and single hyphens.';
  }

  if (name.length === 0) {
    fieldErrors.name = 'Name is required.';
  }

  if (spreadsheetId.length === 0) {
    fieldErrors.spreadsheetId = 'Spreadsheet ID is required.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      value: null,
      fieldErrors,
      isValid: false
    };
  }

  const input: CreateProjectInput = {
    slug,
    name,
    spreadsheetId,
    ...(googleCredentialRef.length > 0 ? { googleCredentialRef } : {}),
    defaultAuthMode: draft.defaultAuthMode
  };
  const parsed = createProjectInputSchema.safeParse(input);

  if (!parsed.success) {
    collectSchemaErrors(fieldErrors, parsed.error.issues);
  }

  return {
    value: parsed.success ? parsed.data : null,
    fieldErrors,
    isValid: parsed.success
  };
}

export function validateCreateTableDraft(
  draft: CreateTableDraft
): DraftValidation<CreateTableInput, TableFieldName> {
  const fieldErrors: Partial<Record<TableFieldName | 'form', string>> = {};
  const tableSlug = draft.tableSlug.trim();
  const sheetTabName = draft.sheetTabName.trim();
  const sheetGid = draft.sheetGid.trim();
  const idColumn = draft.idColumn.trim();
  const indexedFields = draft.indexedFields
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (tableSlug.length === 0) {
    fieldErrors.tableSlug = 'Table slug is required.';
  } else if (!slugPattern.test(tableSlug)) {
    fieldErrors.tableSlug = 'Use lowercase letters, numbers, and single hyphens.';
  }

  if (sheetTabName.length === 0) {
    fieldErrors.sheetTabName = 'Sheet tab is required.';
  }

  if (idColumn.length === 0) {
    fieldErrors.idColumn = 'ID column is required.';
  }

  const headerRow = parsePositiveInteger(draft.headerRow, 'Header row');
  if (headerRow.error) {
    fieldErrors.headerRow = headerRow.error;
  }

  const dataStartRow = parsePositiveInteger(draft.dataStartRow, 'Data start row');
  if (dataStartRow.error) {
    fieldErrors.dataStartRow = dataStartRow.error;
  }

  if (!headerRow.error && !dataStartRow.error && (dataStartRow.value ?? 0) <= (headerRow.value ?? 0)) {
    fieldErrors.dataStartRow = 'dataStartRow must be greater than headerRow.';
  }

  const cacheTtlSeconds = parseNonNegativeInteger(draft.cacheTtlSeconds, 'Cache TTL');
  if (cacheTtlSeconds.error) {
    fieldErrors.cacheTtlSeconds = cacheTtlSeconds.error;
  }

  let parsedSheetGid: number | undefined;
  if (sheetGid.length > 0) {
    const parsed = parseNonNegativeInteger(sheetGid, 'Sheet GID');
    if (parsed.error) {
      fieldErrors.sheetGid = parsed.error;
    } else {
      parsedSheetGid = parsed.value ?? undefined;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      value: null,
      fieldErrors,
      isValid: false
    };
  }

  const input: CreateTableInput = {
    tableSlug,
    sheetTabName,
    ...(parsedSheetGid !== undefined ? { sheetGid: parsedSheetGid } : {}),
    idColumn,
    indexedFields,
    headerRow: headerRow.value ?? undefined,
    dataStartRow: dataStartRow.value ?? undefined,
    cacheTtlSeconds: cacheTtlSeconds.value ?? undefined,
    readEnabled: draft.readEnabled,
    createEnabled: draft.createEnabled,
    updateEnabled: draft.updateEnabled,
    deleteEnabled: draft.deleteEnabled
  };
  const parsed = createTableInputSchema.safeParse(input);

  if (!parsed.success) {
    collectSchemaErrors(fieldErrors, parsed.error.issues);
  }

  return {
    value: parsed.success ? parsed.data : null,
    fieldErrors,
    isValid: parsed.success
  };
}

export function validateCreateKeyDraft(
  draft: CreateKeyDraft,
  selectedProjectSlug: string | null
): DraftValidation<AdminCreateApiKeyInput, KeyFieldName> {
  const fieldErrors: Partial<Record<KeyFieldName | 'form', string>> = {};
  const name = draft.name.trim();

  if (name.length === 0) {
    fieldErrors.name = 'Key name is required.';
  }

  if (draft.scopes.length === 0) {
    fieldErrors.scopes = 'Select at least one scope.';
  }

  if (draft.projectScoped && !selectedProjectSlug) {
    fieldErrors.projectScoped = 'Select a project before creating a scoped key.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      value: null,
      fieldErrors,
      isValid: false
    };
  }

  const input: AdminCreateApiKeyInput = {
    name,
    projectSlug: draft.projectScoped ? selectedProjectSlug : null,
    scopes: draft.scopes
  };
  const parsed = adminCreateApiKeyInputSchema.safeParse(input);

  if (!parsed.success) {
    collectSchemaErrors(fieldErrors, parsed.error.issues);
  }

  return {
    value: parsed.success ? parsed.data : null,
    fieldErrors,
    isValid: parsed.success
  };
}
