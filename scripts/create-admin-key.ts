import { assertPresent, logStep, logSuccess, readJsonEnv, requestJson, requireAdminCredential, requireEnv } from './lib/runtime';

type CreateApiKeyResponse = {
  apiKey: string;
  record: {
    id: string;
    name: string;
    projectSlug: string | null;
    scopes: string[];
  };
};

async function main() {
  const baseUrl = requireEnv('SHEETFLARE_BASE_URL');
  const bearer = requireAdminCredential();
  const name = process.env.SHEETFLARE_ADMIN_KEY_NAME?.trim() || 'sheetflare-admin';
  const scopes = process.env.SHEETFLARE_ADMIN_KEY_SCOPES?.trim()
    ? process.env.SHEETFLARE_ADMIN_KEY_SCOPES.split(',').map((entry) => entry.trim()).filter(Boolean)
    : ['admin:projects', 'admin:keys', 'table:read', 'table:create', 'table:update', 'table:delete'];
  const projectSlug = process.env.SHEETFLARE_ADMIN_KEY_PROJECT?.trim() || undefined;
  const metadata = process.env.SHEETFLARE_ADMIN_KEY_METADATA_JSON?.trim()
    ? readJsonEnv<Record<string, unknown>>('SHEETFLARE_ADMIN_KEY_METADATA_JSON')
    : {};

  logStep(`Creating admin key ${name}`);
  const { data } = await requestJson<CreateApiKeyResponse>({
    baseUrl,
    path: '/v1/admin/keys',
    method: 'POST',
    bearer,
    expectedStatus: 201,
    body: {
      name,
      scopes,
      ...(projectSlug ? { projectSlug } : {}),
      ...metadata
    }
  });
  const responseData = assertPresent(data, 'Admin key creation returned an empty response body.');

  logSuccess(`Created key ${responseData.record.id}`);
  console.log(JSON.stringify(responseData, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
