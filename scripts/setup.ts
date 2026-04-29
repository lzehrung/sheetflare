import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDefaultSetupConfig, parseSetupConfig, serializeSetupConfig } from './lib/setup-config';
import { createConsolePrompter, promptForSetup, type SetupPromptActions, type SetupPrompter } from './lib/setup-prompts';
import { checkSetupPrereqs } from './lib/setup-prereqs';
import { createBootstrapEnv, findCreatedKey, parseBootstrapOutput } from './lib/setup-bootstrap';
import { deployAdminPages, deployApiWorker, getApiWranglerConfigPath, getAdminPagesProjectName } from './lib/setup-deploy';
import { applyAdminSecrets, applyApiSecrets, collectSetupSecrets } from './lib/setup-secrets';
import { createSmokeEnv } from './lib/setup-smoke';
import { getCommandName, runCommand } from './lib/process';
import { ScriptError, getEnv, logSuccess, logStep } from './lib/runtime';

type SetupCliOptions = {
  configPath: string;
  writeDefaultConfig: boolean;
  deploy: boolean;
  bootstrap: boolean;
  smoke: boolean;
};

type SetupExecutionSummary = {
  configPath: string;
  apiUrl: string | null;
  adminUrl: string | null;
  adminBearerToken: string | null;
  adminUiUsername: string | null;
  adminUiPassword: string | null;
  adminApiKey: string | null;
  privateReadKey: string | null;
  mutationKey: string | null;
};

function parseArgs(argv: string[]): SetupCliOptions {
  const options: SetupCliOptions = {
    configPath: 'sheetflare.setup.json',
    writeDefaultConfig: false,
    deploy: false,
    bootstrap: false,
    smoke: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new ScriptError('Missing value for --config.');
      }
      options.configPath = nextValue;
      index += 1;
      continue;
    }

    if (argument === '--write-default-config') {
      options.writeDefaultConfig = true;
      continue;
    }

    if (argument === '--deploy') {
      options.deploy = true;
      continue;
    }

    if (argument === '--bootstrap') {
      options.bootstrap = true;
      continue;
    }

    if (argument === '--smoke') {
      options.smoke = true;
      continue;
    }

    throw new ScriptError(`Unknown setup argument: ${argument}`);
  }

  return options;
}

async function readConfigFile(path: string) {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScriptError(`Setup config ${path} must contain valid JSON.`);
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function renderPrereqSummary(results: Awaited<ReturnType<typeof checkSetupPrereqs>>) {
  for (const result of results) {
    const prefix = result.status === 'ready' ? '[ok]' : result.status === 'warning' ? '[warn]' : '[blocked]';
    console.log(`${prefix} ${result.name}: ${result.summary}`);
    if (result.remediation) {
      console.log(`       ${result.remediation}`);
    }
  }
}

async function promptForText(prompter: SetupPrompter, options: {
  message: string;
  envName?: string;
}) {
  const defaultValue = options.envName ? getEnv(options.envName) : null;
  return prompter.text({
    message: options.message,
    ...(defaultValue ? { defaultValue } : {}),
    validate: (value) => value.trim().length > 0 ? null : `${options.message} must not be blank.`
  });
}

function printExecutionSummary(summary: SetupExecutionSummary) {
  console.log('\nSetup summary');
  console.log(JSON.stringify(summary, null, 2));
}

async function runBootstrap(configPath: string, env: NodeJS.ProcessEnv) {
  void configPath;
  const result = await runCommand(
    getCommandName('npm'),
    ['run', 'ops:bootstrap'],
    {
      cwd: resolve('.'),
      env
    }
  );
  if (result.code !== 0) {
    throw new ScriptError('Bootstrap failed.');
  }

  return parseBootstrapOutput(result.stdout);
}

async function runSmoke(env: NodeJS.ProcessEnv) {
  const result = await runCommand(
    getCommandName('npm'),
    ['run', 'smoke'],
    {
      cwd: resolve('.'),
      env
    }
  );
  if (result.code !== 0) {
    throw new ScriptError('Smoke validation failed.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolvedConfigPath = resolve(options.configPath);

  if (options.writeDefaultConfig) {
    logStep(`Writing starter setup config to ${resolvedConfigPath}`);
    await writeFile(resolvedConfigPath, createDefaultSetupConfig(), 'utf8');
    logSuccess(`Starter config written to ${resolvedConfigPath}`);
    return;
  }

  logStep('Checking setup prerequisites');
  const prereqResults = await checkSetupPrereqs();
  renderPrereqSummary(prereqResults);

  const prompter = process.stdin.isTTY && process.stdout.isTTY
    ? createConsolePrompter()
    : null;
  let configInput: unknown;
  let promptActions: SetupPromptActions | null = null;

  try {
    try {
      logStep(`Loading setup config ${resolvedConfigPath}`);
      configInput = await readConfigFile(resolvedConfigPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      if (!prompter) {
        throw new ScriptError(`Setup config ${resolvedConfigPath} does not exist, and interactive setup requires a TTY. Use --write-default-config to create a starter config.`);
      }

      logStep(`No setup config found at ${resolvedConfigPath}; starting interactive setup`);
      const promptResult = await promptForSetup(prompter);
      promptActions = promptResult.actions;
      configInput = promptResult.config;
      logStep(`Writing setup config ${resolvedConfigPath}`);
      await writeFile(resolvedConfigPath, serializeSetupConfig(promptResult.config), 'utf8');
      logSuccess(`Setup config written to ${resolvedConfigPath}`);
    }

    logStep(`Validating setup config ${resolvedConfigPath}`);
    const config = parseSetupConfig(configInput);
    logSuccess(
      `Validated setup config for profile ${config.profile} with private project ${config.privateProject.slug}.`
    );
    console.log(JSON.stringify({
      profile: config.profile,
      privateProject: config.privateProject.slug,
      publicReadProject: config.publicReadProject?.slug ?? null,
      privateTables: config.privateProject.tables.map((table) => table.tableSlug),
      publicReadTables: config.publicReadProject?.tables.map((table) => table.tableSlug) ?? []
    }, null, 2));

    const actions = promptActions ?? {
      applySecretsNow: options.deploy,
      deployNow: options.deploy,
      bootstrapNow: options.bootstrap,
      smokeNow: options.smoke
    };

    if (!actions.applySecretsNow && !actions.deployNow && !actions.bootstrapNow && !actions.smokeNow) {
      return;
    }

    const wranglerBlocked = prereqResults.some((result) => result.name === 'Wrangler auth' && result.status === 'blocked');
    if ((actions.applySecretsNow || actions.deployNow) && wranglerBlocked) {
      throw new ScriptError('Wrangler authentication is required before applying secrets or deploying. Run npx wrangler login and rerun setup.');
    }

    let apiUrl: string | null = null;
    let adminUrl: string | null = null;
    let adminBearerToken: string | null = null;
    let adminUiUsername: string | null = null;
    let adminUiPassword: string | null = null;
    let adminApiKey: string | null = null;
    let privateReadKey: string | null = null;
    let mutationKey: string | null = null;

    let setupSecrets: Awaited<ReturnType<typeof collectSetupSecrets>> | null = null;
    if (actions.applySecretsNow || actions.deployNow) {
      if (!prompter) {
        throw new ScriptError('Applying secrets or deploying requires an interactive TTY in the current setup implementation.');
      }

      logStep('Collecting setup secrets');
      setupSecrets = await collectSetupSecrets({
        prompter,
        includeAdminUiSecrets: config.deploy.admin
      });
      adminBearerToken = setupSecrets.adminBearerToken;
      adminUiUsername = setupSecrets.adminUiUsername;
      adminUiPassword = setupSecrets.adminUiPassword;

      logStep('Applying Worker secrets');
      await applyApiSecrets({
        apiWranglerConfigPath: getApiWranglerConfigPath(),
        googlePrivateKey: setupSecrets.googlePrivateKey,
        adminBearerToken: setupSecrets.adminBearerToken
      });
      logSuccess('Worker secrets applied');
    }

    if (actions.deployNow) {
      if (!setupSecrets) {
        throw new ScriptError('Setup secrets were not collected before deploy.');
      }

      logStep('Deploying API Worker');
      const apiDeploy = await deployApiWorker(setupSecrets.googleClientEmail);
      apiUrl = apiDeploy.url;
      logSuccess(`API deployed at ${apiUrl}`);

      if (config.deploy.admin) {
        logStep('Deploying admin Pages site');
        const adminDeploy = await deployAdminPages(apiUrl);
        adminUrl = adminDeploy.url;
        logSuccess(`Admin deployed at ${adminUrl}`);

        if (setupSecrets.adminUiUsername && setupSecrets.adminUiPassword) {
          logStep('Applying admin Pages site secrets');
          await applyAdminSecrets({
            pagesProjectName: getAdminPagesProjectName(),
            username: setupSecrets.adminUiUsername,
            password: setupSecrets.adminUiPassword
          });
          logSuccess('Admin site secrets applied');
        }
      }
    }

    if (!apiUrl && (actions.bootstrapNow || actions.smokeNow)) {
      if (!prompter) {
        throw new ScriptError('Bootstrap or smoke without a fresh deploy requires an interactive TTY to collect runtime inputs.');
      }
      apiUrl = (await promptForText(prompter, {
        message: 'Deployed API base URL',
        envName: 'SHEETFLARE_BASE_URL'
      })).trim();
    }

    if (actions.bootstrapNow) {
      if (!apiUrl) {
        throw new ScriptError('API base URL is required for bootstrap.');
      }

      if (!adminBearerToken) {
        if (!prompter) {
          throw new ScriptError('Bootstrap requires an admin credential.');
        }
        adminBearerToken = (await promptForText(prompter, {
          message: 'Admin bootstrap credential',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
      }

      logStep('Bootstrapping projects and API keys');
      const bootstrapOutput = await runBootstrap(
        resolvedConfigPath,
        createBootstrapEnv(config, apiUrl, adminBearerToken)
      );
      adminApiKey = findCreatedKey(bootstrapOutput, config.smoke.adminKeyName);
      privateReadKey = findCreatedKey(bootstrapOutput, config.smoke.privateReadKeyName);
      mutationKey = findCreatedKey(bootstrapOutput, config.smoke.mutationKeyName);
      logSuccess('Bootstrap completed');
    }

    if (actions.smokeNow) {
      if (!apiUrl) {
        throw new ScriptError('API base URL is required for smoke.');
      }

      if (!adminApiKey) {
        if (!prompter) {
          throw new ScriptError('Smoke requires an admin API key or admin credential.');
        }
        adminApiKey = (await promptForText(prompter, {
          message: 'Admin API key for smoke',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
      }
      if (!privateReadKey) {
        if (!prompter) {
          throw new ScriptError('Smoke requires a private read key.');
        }
        privateReadKey = (await promptForText(prompter, {
          message: 'Private read API key for smoke'
        })).trim();
      }
      if (!mutationKey) {
        if (!prompter) {
          throw new ScriptError('Smoke requires a mutation API key.');
        }
        mutationKey = (await promptForText(prompter, {
          message: 'Mutation API key for smoke'
        })).trim();
      }

      logStep('Running smoke validation');
      await runSmoke(createSmokeEnv({
        config,
        baseUrl: apiUrl,
        adminCredential: adminApiKey,
        privateReadKey,
        mutationKey
      }));
      logSuccess('Smoke validation completed');
    }

    printExecutionSummary({
      configPath: resolvedConfigPath,
      apiUrl,
      adminUrl,
      adminBearerToken,
      adminUiUsername,
      adminUiPassword,
      adminApiKey,
      privateReadKey,
      mutationKey
    });
  } finally {
    prompter?.close?.();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
