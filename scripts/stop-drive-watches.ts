import { getEnv, logStep, requestJson, requireAdminCredential, requireEnv } from './lib/runtime';

async function main() {
  const baseUrl = requireEnv(
    'SHEETFLARE_BASE_URL',
    'Set SHEETFLARE_BASE_URL to the deployed API Worker URL, not the admin Pages URL.'
  );
  const bearer = requireAdminCredential();
  const spreadsheetId = getEnv('SHEETFLARE_DRIVE_WATCH_SPREADSHEET_ID');

  logStep('Stopping known Google Drive spreadsheet watches');
  const { data } = await requestJson({
    baseUrl,
    path: '/v1/admin/system/google/drive/watches/stop',
    method: 'POST',
    bearer,
    body: spreadsheetId ? { spreadsheetId } : {},
    expectedStatus: 200
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
