import { logStep, requestJson, requireAdminCredential, requireEnv, ScriptError, getEnv } from './lib/runtime';

function parseOptionalPositiveInteger(name: string) {
  const raw = getEnv(name);
  if (!raw) {
    return null;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ScriptError(`Environment variable ${name} must be a positive integer when provided.`);
  }

  return value;
}

async function main() {
  const baseUrl = requireEnv(
    'SHEETFLARE_BASE_URL',
    'Set SHEETFLARE_BASE_URL to the deployed API Worker URL, not the admin Pages URL.'
  );
  const bearer = requireAdminCredential();
  const debounceSeconds = parseOptionalPositiveInteger('SHEETFLARE_DRIVE_WATCH_DEBOUNCE_SECONDS');
  const expirationHours = parseOptionalPositiveInteger('SHEETFLARE_DRIVE_WATCH_EXPIRATION_HOURS');

  logStep('Registering Google Drive spreadsheet watches');
  const { data } = await requestJson({
    baseUrl,
    path: '/v1/admin/system/google/drive/watches/register',
    method: 'POST',
    bearer,
    body: {
      ...(debounceSeconds ? { debounceSeconds } : {}),
      ...(expirationHours ? { expirationHours } : {})
    },
    expectedStatus: 200
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
