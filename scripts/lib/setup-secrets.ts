import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getCommandName, runCommand } from './process';
import type { SetupPrompter } from './setup-prompts';
import { ScriptError } from './runtime';

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

export type SetupSecrets = {
  googleClientEmail: string;
  googlePrivateKey: string;
  adminBearerToken: string;
  adminUiUsername: string | null;
  adminUiPassword: string | null;
};

export type AdminSiteSecrets = {
  adminUiUsername: string;
  adminUiPassword: string;
};

type AdminSiteSecretState = {
  adminUiUsername: string | null;
  adminUiPassword: string | null;
};

function generateSecretToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function readEnvValue(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

async function readServiceAccountFile(path: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new ScriptError(`Service-account JSON file ${path} could not be read as valid JSON.`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('client_email' in parsed) ||
    !('private_key' in parsed) ||
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string' ||
    parsed.client_email.trim().length === 0 ||
    parsed.private_key.trim().length === 0
  ) {
    throw new ScriptError(`Service-account JSON file ${path} must include non-empty client_email and private_key fields.`);
  }

  return parsed as ServiceAccountCredentials;
}

export async function collectAdminSiteSecrets(options: {
  prompter: SetupPrompter | null;
  defaultAdminUiUsername?: string | null;
  defaultAdminUiPassword?: string | null;
}) : Promise<AdminSiteSecrets> {
  const defaultAdminUiUsername = readEnvValue('ADMIN_UI_USERNAME')
    ?? options.defaultAdminUiUsername?.trim()
    ?? null;
  const defaultAdminUiPassword = readEnvValue('ADMIN_UI_PASSWORD')
    ?? options.defaultAdminUiPassword?.trim()
    ?? null;

  if (!options.prompter) {
    if (!defaultAdminUiUsername || !defaultAdminUiPassword) {
      throw new ScriptError(
        'Admin UI deploy requires ADMIN_UI_USERNAME and ADMIN_UI_PASSWORD from local setup state or the environment. Run npm run setup -- --apply-secrets first, or set those environment variables before deploying the admin UI.'
      );
    }

    return {
      adminUiUsername: defaultAdminUiUsername,
      adminUiPassword: defaultAdminUiPassword
    };
  }

  const adminUiUsername = await options.prompter.text({
    message: 'Admin UI site username',
    ...(defaultAdminUiUsername ? { defaultValue: defaultAdminUiUsername } : {}),
    validate: (value) => value.trim().length > 0 ? null : 'Admin UI username must not be blank.'
  });
  const adminUiPasswordInput = await options.prompter.text({
    message: 'Admin UI site password (leave blank to generate)',
    ...(defaultAdminUiPassword ? { defaultValue: defaultAdminUiPassword } : {})
  });
  const adminUiPassword = adminUiPasswordInput.trim().length > 0 ? adminUiPasswordInput : generateSecretToken(24);

  return {
    adminUiUsername: adminUiUsername.trim(),
    adminUiPassword
  };
}

export function requireAdminSiteSecrets(state: AdminSiteSecretState): AdminSiteSecrets {
  if (!state.adminUiUsername?.trim() || !state.adminUiPassword?.trim()) {
    throw new ScriptError(
      'Admin UI deploy requires ADMIN_UI_USERNAME and ADMIN_UI_PASSWORD from local setup state or the environment. Run npm run setup -- --apply-secrets first, or set those environment variables before deploying the admin UI.'
    );
  }

  return {
    adminUiUsername: state.adminUiUsername,
    adminUiPassword: state.adminUiPassword
  };
}

export async function collectSetupSecrets(options: {
  prompter: SetupPrompter | null;
  includeAdminUiSecrets: boolean;
  defaultAdminUiUsername?: string | null;
  defaultAdminUiPassword?: string | null;
}) : Promise<SetupSecrets> {
  const envGoogleClientEmail = readEnvValue('GOOGLE_CLIENT_EMAIL');
  const envGooglePrivateKey = process.env.GOOGLE_PRIVATE_KEY;

  let googleClientEmail: string;
  let googlePrivateKey: string;

  if (envGoogleClientEmail && envGooglePrivateKey && envGooglePrivateKey.trim().length > 0) {
    googleClientEmail = envGoogleClientEmail;
    googlePrivateKey = envGooglePrivateKey;
  } else if (readEnvValue('GOOGLE_APPLICATION_CREDENTIALS')) {
    const credentials = await readServiceAccountFile(readEnvValue('GOOGLE_APPLICATION_CREDENTIALS')!);
    googleClientEmail = credentials.client_email.trim();
    googlePrivateKey = credentials.private_key;
  } else {
    if (!options.prompter) {
      throw new ScriptError(
        'Applying secrets without a TTY requires GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON file.'
      );
    }

    let credentials: ServiceAccountCredentials | null = null;
    while (!credentials) {
      const defaultPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
      const serviceAccountPath = await options.prompter.text({
        message: 'Path to Google service-account JSON',
        ...(defaultPath ? { defaultValue: defaultPath } : {}),
        validate: (value) => value.trim().length > 0 ? null : 'Service-account JSON path must not be blank.'
      });
      try {
        credentials = await readServiceAccountFile(serviceAccountPath.trim());
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    }
    googleClientEmail = credentials.client_email.trim();
    googlePrivateKey = credentials.private_key;
  }

  const adminBearerToken = readEnvValue('ADMIN_BEARER_TOKEN') ?? generateSecretToken(32);

  if (!options.includeAdminUiSecrets) {
    return {
      googleClientEmail,
      googlePrivateKey,
      adminBearerToken,
      adminUiUsername: null,
      adminUiPassword: null
    };
  }
  const adminSiteSecrets = await collectAdminSiteSecrets({
    prompter: options.prompter,
    defaultAdminUiUsername: options.defaultAdminUiUsername ?? 'admin',
    ...(options.defaultAdminUiPassword !== undefined ? { defaultAdminUiPassword: options.defaultAdminUiPassword } : {})
  });

  return {
    googleClientEmail,
    googlePrivateKey,
    adminBearerToken,
    adminUiUsername: adminSiteSecrets.adminUiUsername,
    adminUiPassword: adminSiteSecrets.adminUiPassword
  };
}

export async function applyApiSecrets(options: {
  apiWranglerConfigPath: string;
  googlePrivateKey: string;
  adminBearerToken: string;
}) {
  const wrangler = getCommandName('npx');
  const commands = buildApiSecretCommands(options.apiWranglerConfigPath);
  const privateKeyResult = await runCommand(
    wrangler,
    commands.googlePrivateKey,
    {
      input: `${options.googlePrivateKey}\n`
    }
  );
  if (privateKeyResult.code !== 0) {
    throw new ScriptError('Failed to apply GOOGLE_PRIVATE_KEY with wrangler secret put.');
  }

  const bearerResult = await runCommand(
    wrangler,
    commands.adminBearerToken,
    {
      input: `${options.adminBearerToken}\n`
    }
  );
  if (bearerResult.code !== 0) {
    throw new ScriptError('Failed to apply ADMIN_BEARER_TOKEN with wrangler secret put.');
  }
}

export async function applyAdminSecrets(options: {
  pagesProjectName: string;
  username: string;
  password: string;
}) {
  const wrangler = getCommandName('npx');
  const commands = buildAdminSecretCommands(options.pagesProjectName);
  const usernameResult = await runCommand(
    wrangler,
    commands.username,
    {
      input: `${options.username}\n`
    }
  );
  if (usernameResult.code !== 0) {
    throw new ScriptError('Failed to apply ADMIN_UI_USERNAME with wrangler pages secret put.');
  }

  const passwordResult = await runCommand(
    wrangler,
    commands.password,
    {
      input: `${options.password}\n`
    }
  );
  if (passwordResult.code !== 0) {
    throw new ScriptError('Failed to apply ADMIN_UI_PASSWORD with wrangler pages secret put.');
  }
}

export function buildApiSecretCommands(apiWranglerConfigPath: string) {
  return {
    googlePrivateKey: ['wrangler', 'secret', 'put', 'GOOGLE_PRIVATE_KEY', '--config', apiWranglerConfigPath],
    adminBearerToken: ['wrangler', 'secret', 'put', 'ADMIN_BEARER_TOKEN', '--config', apiWranglerConfigPath]
  };
}

export function buildAdminSecretCommands(pagesProjectName: string) {
  return {
    username: ['wrangler', 'pages', 'secret', 'put', 'ADMIN_UI_USERNAME', '--project-name', pagesProjectName],
    password: ['wrangler', 'pages', 'secret', 'put', 'ADMIN_UI_PASSWORD', '--project-name', pagesProjectName]
  };
}
