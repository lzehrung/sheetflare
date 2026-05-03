import { logStep, requestJson, requireAdminCredential, requireEnv } from './lib/runtime';

async function main() {
  const baseUrl = requireEnv(
    'SHEETFLARE_BASE_URL',
    'Set SHEETFLARE_BASE_URL to the deployed API Worker URL, not the admin Pages URL.'
  );
  const bearer = requireAdminCredential();

  logStep('Fetching Google Drive spreadsheet watch retry advice');
  const { data } = await requestJson({
    baseUrl,
    path: '/v1/admin/system/google/drive/watches/retry-advice',
    method: 'GET',
    bearer,
    expectedStatus: 200
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
