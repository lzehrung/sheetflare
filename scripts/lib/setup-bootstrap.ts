import type { BootstrapConfig } from './bootstrap-config';
import type { SetupConfig } from './setup-config';

type CreatedKeyRecord = {
  id: string;
  name: string;
  projectSlug: string | null;
  scopes: string[];
};

export type SetupBootstrapOutput = {
  projects: Array<{
    slug: string;
    tables: string[];
  }>;
  apiKeys: Array<{
    apiKey: string;
    record: CreatedKeyRecord;
  }>;
};

export function createBootstrapConfigFromSetup(config: SetupConfig): BootstrapConfig {
  const projects: BootstrapConfig['projects'] = [
    {
      slug: config.privateProject.slug,
      name: config.privateProject.name,
      spreadsheetId: config.privateProject.spreadsheetId,
      ...(config.privateProject.googleCredentialRef ? { googleCredentialRef: config.privateProject.googleCredentialRef } : {}),
      defaultAuthMode: 'private',
      tables: config.privateProject.tables
    }
  ];

  if (config.publicReadProject) {
    projects.push({
      slug: config.publicReadProject.slug,
      name: config.publicReadProject.name,
      spreadsheetId: config.publicReadProject.spreadsheetId,
      ...(config.publicReadProject.googleCredentialRef ? { googleCredentialRef: config.publicReadProject.googleCredentialRef } : {}),
      defaultAuthMode: 'public-read',
      tables: config.publicReadProject.tables
    });
  }

  return {
    projects,
    apiKeys: config.smoke.enabled
      ? [
          {
            name: config.smoke.adminKeyName,
            scopes: ['admin:projects', 'admin:keys', 'table:read', 'table:create', 'table:update', 'table:delete']
          },
          {
            name: config.smoke.privateReadKeyName,
            projectSlug: config.privateProject.slug,
            scopes: ['table:read']
          },
          {
            name: config.smoke.mutationKeyName,
            projectSlug: config.privateProject.slug,
            scopes: ['table:read', 'table:create', 'table:update', 'table:delete']
          }
        ]
      : []
  };
}

export function createBootstrapEnv(config: SetupConfig, baseUrl: string, adminCredential: string) {
  return {
    SHEETFLARE_BASE_URL: baseUrl,
    SHEETFLARE_ADMIN_CREDENTIAL: adminCredential,
    SHEETFLARE_BOOTSTRAP_CONFIG_JSON: JSON.stringify(createBootstrapConfigFromSetup(config)),
    SHEETFLARE_BOOTSTRAP_RESULT_MODE: 'full'
  } satisfies NodeJS.ProcessEnv;
}

export function parseBootstrapOutput(stdout: string): SetupBootstrapOutput {
  const marker = '__SHEETFLARE_BOOTSTRAP_RESULT__=';
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error('Bootstrap output did not include the setup bootstrap result marker.');
  }

  const markerLine = stdout
    .slice(markerIndex + marker.length)
    .split(/\r?\n/u, 1)[0];
  if (!markerLine) {
    throw new Error('Bootstrap output marker was present but empty.');
  }

  return JSON.parse(markerLine) as SetupBootstrapOutput;
}

export function findCreatedKey(output: SetupBootstrapOutput, keyName: string) {
  const match = output.apiKeys.find((entry) => entry.record.name === keyName);
  if (!match) {
    throw new Error(`Bootstrap output did not include the expected API key ${keyName}.`);
  }

  return match.apiKey;
}
