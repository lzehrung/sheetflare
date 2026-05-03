import { logStep, requestJson, requireAdminCredential, requireEnv } from './lib/runtime';

async function main() {
  const baseUrl = requireEnv('SHEETFLARE_BASE_URL', 'Set SHEETFLARE_BASE_URL to the deployed API Worker URL.');
  const bearer = requireAdminCredential();
  const project = requireEnv('SHEETFLARE_PROJECT', 'Set SHEETFLARE_PROJECT to the project slug to inspect.');
  const table = requireEnv('SHEETFLARE_TABLE', 'Set SHEETFLARE_TABLE to the table slug to inspect.');

  logStep(`Fetching cache status for ${project}/${table}`);
  const { data } = await requestJson({
    baseUrl,
    path: `/v1/admin/projects/${encodeURIComponent(project)}/tables/${encodeURIComponent(table)}/cache`,
    bearer,
    expectedStatus: 200
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
