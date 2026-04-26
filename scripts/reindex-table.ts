import { logStep, requestJson, requireAdminCredential, requireEnv } from './lib/runtime';

async function main() {
  const baseUrl = requireEnv('SHEETFLARE_BASE_URL');
  const bearer = requireAdminCredential();
  const project = requireEnv('SHEETFLARE_PROJECT');
  const table = requireEnv('SHEETFLARE_TABLE');

  logStep(`Reindexing ${project}/${table}`);
  const { data } = await requestJson({
    baseUrl,
    path: `/v1/admin/projects/${encodeURIComponent(project)}/tables/${encodeURIComponent(table)}/reindex`,
    method: 'POST',
    bearer,
    expectedStatus: 200
  });

  console.log(JSON.stringify(data, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
