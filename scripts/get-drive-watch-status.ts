import { listDriveWatches } from './lib/setup-drive-watches';
import { getEnv, logStep, requireAdminCredential, requireEnv, ScriptError } from './lib/runtime';

function parseOptionalNonNegativeInteger(name: string) {
  const raw = getEnv(name);
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ScriptError(`Environment variable ${name} must be a non-negative integer when provided.`);
  }

  return value;
}

async function main() {
  const baseUrl = requireEnv('SHEETFLARE_BASE_URL');
  const bearer = requireAdminCredential();
  const retries = parseOptionalNonNegativeInteger('SHEETFLARE_DRIVE_WATCH_STATUS_RETRIES') ?? 2;
  const retryDelayMs = parseOptionalNonNegativeInteger('SHEETFLARE_DRIVE_WATCH_STATUS_RETRY_DELAY_MS') ?? 1000;

  logStep('Fetching Google Drive spreadsheet watch status');
  const data = await listDriveWatches({
    baseUrl,
    adminCredential: bearer,
    retries,
    retryDelayMs
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
