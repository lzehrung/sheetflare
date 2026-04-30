import {
  assertPresent,
  logStep,
  logSuccess,
  readJsonEnv,
  redactSecret,
  requestJson,
  requireAdminCredential,
  requireEnv,
  shouldShowSecrets
} from './lib/runtime';
import { parseBootstrapConfig, type BootstrapConfig } from './lib/bootstrap-config';

type ProjectResponse = {
  project: {
    slug: string;
  };
};

type TableResponse = {
  data: {
    projectSlug: string;
    tableSlug: string;
  };
};

type ApiKeyResponse = {
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
  const config = parseBootstrapConfig(readJsonEnv<BootstrapConfig>('SHEETFLARE_BOOTSTRAP_CONFIG_JSON'));

  const createdKeys: ApiKeyResponse[] = [];

  for (const project of config.projects) {
    logStep(`Ensuring project ${project.slug}`);
    const projectResponse = await requestJson<ProjectResponse>({
      baseUrl,
      path: '/v1/admin/projects?upsert=true',
      method: 'POST',
      bearer,
      expectedStatus: 201,
      body: {
        slug: project.slug,
        name: project.name,
        spreadsheetId: project.spreadsheetId,
        ...(project.googleCredentialRef ? { googleCredentialRef: project.googleCredentialRef } : {}),
        ...(project.defaultAuthMode ? { defaultAuthMode: project.defaultAuthMode } : {})
      }
    });
    logSuccess(`Project ready: ${assertPresent(projectResponse.data, 'Project creation returned an empty response body.').project.slug}`);

    for (const table of project.tables ?? []) {
      logStep(`Ensuring table ${project.slug}/${table.tableSlug}`);
      const tableResponse = await requestJson<TableResponse>({
        baseUrl,
        path: `/v1/admin/projects/${encodeURIComponent(project.slug)}/tables?upsert=true`,
        method: 'POST',
        bearer,
        expectedStatus: 201,
        body: table
      });
      const tableData = assertPresent(tableResponse.data, 'Table creation returned an empty response body.');
      logSuccess(`Table ready: ${tableData.data.projectSlug}/${tableData.data.tableSlug}`);
    }
  }

  for (const apiKey of config.apiKeys ?? []) {
    logStep(`Creating key ${apiKey.name}`);
    const apiKeyResponse = await requestJson<ApiKeyResponse>({
      baseUrl,
      path: '/v1/admin/keys',
      method: 'POST',
      bearer,
      expectedStatus: 201,
      body: apiKey
    });
    const createdKey = assertPresent(apiKeyResponse.data, 'API key creation returned an empty response body.');
    createdKeys.push(createdKey);
    logSuccess(`Key created: ${createdKey.record.id}`);
  }

  const output = {
    projects: config.projects.map((project) => ({
      slug: project.slug,
      tables: (project.tables ?? []).map((table) => table.tableSlug)
    })),
    apiKeys: createdKeys
  };

  console.log(JSON.stringify({
    ...output,
    apiKeys: output.apiKeys.map((apiKey) => ({
      ...apiKey,
      apiKey: shouldShowSecrets() ? apiKey.apiKey : redactSecret(apiKey.apiKey)
    }))
  }, null, 2));

  if (process.env.SHEETFLARE_BOOTSTRAP_RESULT_MODE === 'full') {
    console.log(`__SHEETFLARE_BOOTSTRAP_RESULT__=${JSON.stringify(output)}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
