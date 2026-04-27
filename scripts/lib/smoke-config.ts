import { ScriptError, requireAdminCredential, requireEnv, readJsonEnv } from './runtime';

export type SmokeConfig = {
  baseUrl: string;
  adminCredential: string;
  privateProject: string;
  privateTable: string;
  privateReadKey: string;
  mutationKey: string;
  publicProject: string;
  publicTable: string;
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
  if (rawIdColumn !== undefined && rawIdColumn.trim().length === 0) {
    throw new ScriptError('SHEETFLARE_SMOKE_ID_COLUMN must not be blank when provided.');
  }
  const idColumn = rawIdColumn?.trim() || '_id';

  return withEnv('SHEETFLARE_BASE_URL', () => ({
    baseUrl: requireEnv('SHEETFLARE_BASE_URL'),
    adminCredential: requireAdminCredential(),
    privateProject: requireEnv('SHEETFLARE_PRIVATE_PROJECT'),
    privateTable: requireEnv('SHEETFLARE_PRIVATE_TABLE'),
    privateReadKey: requireEnv('SHEETFLARE_PRIVATE_READ_KEY'),
    mutationKey: requireEnv('SHEETFLARE_MUTATION_KEY'),
    publicProject: requireEnv('SHEETFLARE_PUBLIC_PROJECT'),
    publicTable: requireEnv('SHEETFLARE_PUBLIC_TABLE'),
    idColumn,
    createValues: readJsonEnv<Record<string, unknown>>('SHEETFLARE_SMOKE_CREATE_VALUES_JSON'),
    updateValues: readJsonEnv<Record<string, unknown>>('SHEETFLARE_SMOKE_UPDATE_VALUES_JSON')
  }));
}
