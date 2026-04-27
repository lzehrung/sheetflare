import { ScriptError, getEnv } from './runtime';
import { readSmokeConfig, type SmokeConfig } from './smoke-config';

export type LoadConfig = SmokeConfig & {
  reportPath: string | null;
  indexedListRequests: number;
  indexedListConcurrency: number;
  pointReadRequests: number;
  pointReadConcurrency: number;
  mutationCycles: number;
  mutationConcurrency: number;
  staleWaitMs: number;
  rateLimitSamePrincipalRequests: number;
  rateLimitPrincipalCount: number;
  rateLimitRequestsPerPrincipal: number;
  reindexReadRequests: number;
  reindexReadConcurrency: number;
  manualChurnPauseMs: number;
  indexedListSort: string;
};

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
) {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ScriptError(`${name} must be a positive integer when provided.`);
  }

  return parsed;
}

function readNonNegativeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
) {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ScriptError(`${name} must be a non-negative integer when provided.`);
  }

  return parsed;
}

export function readLoadConfig(env: NodeJS.ProcessEnv = process.env): LoadConfig {
  const smoke = readSmokeConfig(env);
  const indexedListSort = env.SHEETFLARE_LOAD_SORT?.trim() || `${smoke.idColumn}:asc`;

  return {
    ...smoke,
    reportPath: env.SHEETFLARE_LOAD_REPORT_PATH?.trim() || null,
    indexedListRequests: readPositiveInteger(env, 'SHEETFLARE_LOAD_INDEXED_LIST_REQUESTS', 60),
    indexedListConcurrency: readPositiveInteger(env, 'SHEETFLARE_LOAD_INDEXED_LIST_CONCURRENCY', 6),
    pointReadRequests: readPositiveInteger(env, 'SHEETFLARE_LOAD_POINT_READ_REQUESTS', 30),
    pointReadConcurrency: readPositiveInteger(env, 'SHEETFLARE_LOAD_POINT_READ_CONCURRENCY', 3),
    mutationCycles: readPositiveInteger(env, 'SHEETFLARE_LOAD_MUTATION_CYCLES', 12),
    mutationConcurrency: readPositiveInteger(env, 'SHEETFLARE_LOAD_MUTATION_CONCURRENCY', 2),
    staleWaitMs: readNonNegativeInteger(env, 'SHEETFLARE_LOAD_STALE_WAIT_MS', 16_000),
    rateLimitSamePrincipalRequests: readPositiveInteger(env, 'SHEETFLARE_LOAD_RATE_LIMIT_SAME_PRINCIPAL_REQUESTS', 400),
    rateLimitPrincipalCount: readPositiveInteger(env, 'SHEETFLARE_LOAD_RATE_LIMIT_PRINCIPAL_COUNT', 25),
    rateLimitRequestsPerPrincipal: readPositiveInteger(env, 'SHEETFLARE_LOAD_RATE_LIMIT_REQUESTS_PER_PRINCIPAL', 3),
    reindexReadRequests: readPositiveInteger(env, 'SHEETFLARE_LOAD_REINDEX_READ_REQUESTS', 40),
    reindexReadConcurrency: readPositiveInteger(env, 'SHEETFLARE_LOAD_REINDEX_READ_CONCURRENCY', 4),
    manualChurnPauseMs: readNonNegativeInteger(env, 'SHEETFLARE_LOAD_MANUAL_CHURN_PAUSE_MS', 0),
    indexedListSort
  };
}
