import type { BootstrapConfig } from './bootstrap-config';
import type { SetupConfig } from './setup-config';

type ManagedKeyRef = {
  id: string;
  name: string;
};

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
  /** Keys minted by this run. Only these carry secret material. */
  apiKeys: Array<{
    apiKey: string;
    record: CreatedKeyRecord;
  }>;
  /** Managed keys that already had an active key and were left alone. */
  skippedKeys: ManagedKeyRef[];
  /** Prior managed keys revoked by an explicit rotation. */
  revokedKeys: ManagedKeyRef[];
};

type RawBootstrapOutput = Omit<SetupBootstrapOutput, 'skippedKeys' | 'revokedKeys'>
  & Partial<Pick<SetupBootstrapOutput, 'skippedKeys' | 'revokedKeys'>>;

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

export function createBootstrapEnv(
  config: SetupConfig,
  baseUrl: string,
  adminCredential: string,
  options: { rotateKeys?: boolean } = {}
) {
  return {
    SHEETFLARE_BASE_URL: baseUrl,
    SHEETFLARE_ADMIN_CREDENTIAL: adminCredential,
    SHEETFLARE_BOOTSTRAP_CONFIG_JSON: JSON.stringify(createBootstrapConfigFromSetup(config)),
    SHEETFLARE_BOOTSTRAP_RESULT_MODE: 'full',
    ...(options.rotateKeys ? { SHEETFLARE_BOOTSTRAP_ROTATE_KEYS: 'true' } : {})
  } satisfies NodeJS.ProcessEnv;
}

export function createBootstrapCommandOptions(env: NodeJS.ProcessEnv) {
  return {
    env,
    echoStdout: false,
    echoStderr: false
  } as const;
}

const bootstrapResultMarker = '__SHEETFLARE_BOOTSTRAP_RESULT__=';

export function redactBootstrapResultMarker(stdout: string) {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith(bootstrapResultMarker))
    .join('\n');
}

export function parseBootstrapOutput(stdout: string): SetupBootstrapOutput {
  const markerIndex = stdout.lastIndexOf(bootstrapResultMarker);
  if (markerIndex < 0) {
    throw new Error('Bootstrap output did not include the setup bootstrap result marker.');
  }

  const markerLine = stdout
    .slice(markerIndex + bootstrapResultMarker.length)
    .split(/\r?\n/u, 1)[0];
  if (!markerLine) {
    throw new Error('Bootstrap output marker was present but empty.');
  }

  const parsed: RawBootstrapOutput = JSON.parse(markerLine);
  return {
    ...parsed,
    skippedKeys: parsed.skippedKeys ?? [],
    revokedKeys: parsed.revokedKeys ?? []
  };
}

export function findCreatedKeyIfPresent(output: SetupBootstrapOutput, keyName: string) {
  return output.apiKeys.find((entry) => entry.record.name === keyName)?.apiKey ?? null;
}

export function findCreatedKey(output: SetupBootstrapOutput, keyName: string) {
  const key = findCreatedKeyIfPresent(output, keyName);
  if (key === null) {
    throw new Error(`Bootstrap output did not include the expected API key ${keyName}.`);
  }

  return key;
}
