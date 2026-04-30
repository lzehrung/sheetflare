import { ScriptError, requireAdminCredential, requireEnv, readJsonEnv } from './runtime';

export type SmokeConfig = {
  baseUrl: string;
  adminCredential: string;
  privateProject: string;
  privateTable: string;
  privateReadKey: string;
  mutationKey: string;
  publicProject: string | null;
  publicTable: string | null;
  idColumn: string;
  createValues: Record<string, unknown>;
  updateValues: Record<string, unknown>;
};

export function readSmokeConfig(env: NodeJS.ProcessEnv = process.env): SmokeConfig {
  const withEnv = <T>(name: string, reader: () => T) => {
    const previous = process.env;
    try {
      process.env = env;
      return reader();
    } finally {
      process.env = previous;
    }
  };

  const rawIdColumn = env.SHEETFLARE_SMOKE_ID_COLUMN;
  const rawPublicProject = env.SHEETFLARE_PUBLIC_PROJECT?.trim() || null;
  const rawPublicTable = env.SHEETFLARE_PUBLIC_TABLE?.trim() || null;
  if (rawIdColumn !== undefined && rawIdColumn.trim().length === 0) {
    throw new ScriptError('SHEETFLARE_SMOKE_ID_COLUMN must not be blank when provided.');
  }
  if ((rawPublicProject && !rawPublicTable) || (!rawPublicProject && rawPublicTable)) {
    throw new ScriptError('SHEETFLARE_PUBLIC_PROJECT and SHEETFLARE_PUBLIC_TABLE must be set together when public-read coverage is enabled.');
  }
  const idColumn = rawIdColumn?.trim() || '_id';

  return withEnv('SHEETFLARE_BASE_URL', () => ({
    baseUrl: requireEnv('SHEETFLARE_BASE_URL'),
    adminCredential: requireAdminCredential(),
    privateProject: requireEnv('SHEETFLARE_PRIVATE_PROJECT'),
    privateTable: requireEnv('SHEETFLARE_PRIVATE_TABLE'),
    privateReadKey: requireEnv('SHEETFLARE_PRIVATE_READ_KEY'),
    mutationKey: requireEnv('SHEETFLARE_MUTATION_KEY'),
    publicProject: rawPublicProject,
    publicTable: rawPublicTable,
    idColumn,
    createValues: readJsonEnv<Record<string, unknown>>('SHEETFLARE_SMOKE_CREATE_VALUES_JSON'),
    updateValues: readJsonEnv<Record<string, unknown>>('SHEETFLARE_SMOKE_UPDATE_VALUES_JSON')
  }));
}
