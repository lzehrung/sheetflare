import type { SetupConfig } from './setup-config';
import { ScriptError } from './runtime';

export function createSmokeEnv(options: {
  config: SetupConfig;
  baseUrl: string;
  adminCredential: string;
  privateReadKey: string;
  mutationKey: string;
}) {
  const privateTableSlug = options.config.smoke.privateTableSlug;
  const publicTableSlug = options.config.smoke.publicTableSlug;

  return {
    SHEETFLARE_BASE_URL: options.baseUrl,
    SHEETFLARE_ADMIN_CREDENTIAL: options.adminCredential,
    SHEETFLARE_PRIVATE_PROJECT: options.config.privateProject.slug,
    SHEETFLARE_PRIVATE_TABLE: privateTableSlug,
    SHEETFLARE_PRIVATE_READ_KEY: options.privateReadKey,
    SHEETFLARE_MUTATION_KEY: options.mutationKey,
    ...(options.config.publicReadProject && publicTableSlug
      ? {
          SHEETFLARE_PUBLIC_PROJECT: options.config.publicReadProject.slug,
          SHEETFLARE_PUBLIC_TABLE: publicTableSlug
        }
      : {}),
    SHEETFLARE_SMOKE_ID_COLUMN: findTableIdColumn(options.config.privateProject.tables, privateTableSlug),
    SHEETFLARE_SMOKE_CREATE_VALUES_JSON: JSON.stringify(options.config.smoke.createValues),
    SHEETFLARE_SMOKE_UPDATE_VALUES_JSON: JSON.stringify(options.config.smoke.updateValues)
  } satisfies NodeJS.ProcessEnv;
}

function findTableIdColumn(tables: SetupConfig['privateProject']['tables'], tableSlug: string) {
  const table = tables.find((entry) => entry.tableSlug === tableSlug);
  if (!table) {
    throw new ScriptError(`Private table ${tableSlug} was not found in setup config.`);
  }

  return table.idColumn ?? '_id';
}
