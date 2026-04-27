import { ScriptError, requireAdminCredential, requireEnv, readJsonEnv } from './runtime';

export type CacheHealthTarget = {
  project: string;
  table: string;
};

export type CacheHealthConfig = {
  baseUrl: string;
  adminCredential: string;
  targets: CacheHealthTarget[];
  reportPath: string | null;
};

export function readCacheHealthConfig(env: NodeJS.ProcessEnv = process.env): CacheHealthConfig {
  const previous = process.env;

  try {
    process.env = env;
    const targets = readJsonEnv<CacheHealthTarget[]>('SHEETFLARE_CACHE_HEALTH_TABLES_JSON');
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ScriptError('SHEETFLARE_CACHE_HEALTH_TABLES_JSON must contain at least one target.');
    }

    for (const [index, target] of targets.entries()) {
      if (!target || typeof target.project !== 'string' || target.project.trim().length === 0) {
        throw new ScriptError(`Cache health target ${index + 1} is missing a non-empty project.`);
      }
      if (typeof target.table !== 'string' || target.table.trim().length === 0) {
        throw new ScriptError(`Cache health target ${index + 1} is missing a non-empty table.`);
      }
    }

    return {
      baseUrl: requireEnv('SHEETFLARE_BASE_URL'),
      adminCredential: requireAdminCredential(),
      targets: targets.map((target) => ({
        project: target.project.trim(),
        table: target.table.trim()
      })),
      reportPath: env.SHEETFLARE_CACHE_HEALTH_REPORT_PATH?.trim() || null
    };
  } finally {
    process.env = previous;
  }
}
