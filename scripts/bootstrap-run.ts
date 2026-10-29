import {
  assertPresent,
  getProcessEnv,
  isDirectScriptExecution,
  isEnvFlagEnabled,
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
import { assertRotationCanHandOffKeys, bootstrapApiKeys } from './lib/bootstrap-keys';

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

export async function runOpsBootstrap() {
  const baseUrl = requireEnv('SHEETFLARE_BASE_URL', 'Set SHEETFLARE_BASE_URL to the deployed API Worker URL.');
  const bearer = requireAdminCredential();
  const config = parseBootstrapConfig(readJsonEnv<BootstrapConfig>('SHEETFLARE_BOOTSTRAP_CONFIG_JSON'));
  const rotateKeys = isEnvFlagEnabled('SHEETFLARE_BOOTSTRAP_ROTATE_KEYS');
  assertRotationCanHandOffKeys({
    rotate: rotateKeys,
    showSecrets: shouldShowSecrets(),
    capturedBySetup: getProcessEnv().SHEETFLARE_BOOTSTRAP_RESULT_MODE === 'full'
  });

  for (const project of config.projects) {
    logStep(`Ensuring project ${project.slug}`);
    const projectResponse = await requestJson<ProjectResponse>({
      baseUrl,
      path: '/v1/admin/projects?upsert=true',
      method: 'POST',
      bearer,
      expectedStatus: [200, 201],
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
        expectedStatus: [200, 201],
        body: table
      });
      const tableData = assertPresent(tableResponse.data, 'Table creation returned an empty response body.');
      logSuccess(`Table ready: ${tableData.data.projectSlug}/${tableData.data.tableSlug}`);
    }
  }

  const keyResult = await bootstrapApiKeys({
    baseUrl,
    bearer,
    apiKeys: config.apiKeys ?? [],
    rotate: rotateKeys
  });

  const output = {
    projects: config.projects.map((project) => ({
      slug: project.slug,
      tables: (project.tables ?? []).map((table) => table.tableSlug)
    })),
    apiKeys: keyResult.created,
    skippedKeys: keyResult.skipped,
    revokedKeys: keyResult.revoked
  };

  console.log(JSON.stringify({
    ...output,
    apiKeys: output.apiKeys.map((apiKey) => ({
      ...apiKey,
      apiKey: shouldShowSecrets() ? apiKey.apiKey : redactSecret(apiKey.apiKey)
    }))
  }, null, 2));

  if (getProcessEnv().SHEETFLARE_BOOTSTRAP_RESULT_MODE === 'full') {
    console.log(`__SHEETFLARE_BOOTSTRAP_RESULT__=${JSON.stringify(output)}`);
  }
}

if (isDirectScriptExecution(import.meta.url)) {
  void runOpsBootstrap().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
