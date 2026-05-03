import { ScriptError } from './runtime';

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

export type BenchmarkConfig = {
  baseUrl: string;
  adminCredential: string;
  privateProject: string;
  privateTable: string;
  privateReadKey: string;
  reportPath: string;
  targetRows: number;
  batchRows: number;
  staleWaitMs: number;
  googleClientEmail: string;
  googlePrivateKey: string;
};

export function readBenchmarkConfig(env: NodeJS.ProcessEnv = process.env): BenchmarkConfig {
  const adminCredential = env.SHEETFLARE_ADMIN_CREDENTIAL?.trim() || env.SHEETFLARE_ADMIN_BEARER?.trim() || '';
  if (!adminCredential) {
    throw new ScriptError('Missing required environment variable SHEETFLARE_ADMIN_CREDENTIAL (or legacy SHEETFLARE_ADMIN_BEARER).');
  }

  const readRequiredEnv = (name: string) => {
    const value = env[name]?.trim() || '';
    if (!value) {
      throw new ScriptError(`Missing required environment variable ${name}.`);
    }

    return value;
  };

  return {
    baseUrl: readRequiredEnv('SHEETFLARE_BASE_URL'),
    adminCredential,
    privateProject: readRequiredEnv('SHEETFLARE_PRIVATE_PROJECT'),
    privateTable: readRequiredEnv('SHEETFLARE_PRIVATE_TABLE'),
    privateReadKey: readRequiredEnv('SHEETFLARE_PRIVATE_READ_KEY'),
    reportPath: readRequiredEnv('SHEETFLARE_BENCHMARK_REPORT_PATH'),
    targetRows: readPositiveInteger(env, 'SHEETFLARE_BENCHMARK_TARGET_ROWS', 500_000),
    batchRows: readPositiveInteger(env, 'SHEETFLARE_BENCHMARK_BATCH_ROWS', 1_000),
    staleWaitMs: readNonNegativeInteger(env, 'SHEETFLARE_BENCHMARK_STALE_WAIT_MS', 16_000),
    googleClientEmail: readRequiredEnv('GOOGLE_CLIENT_EMAIL'),
    googlePrivateKey: readRequiredEnv('GOOGLE_PRIVATE_KEY')
  };
}
