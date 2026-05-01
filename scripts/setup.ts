import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDefaultSetupConfig, parseSetupConfig, serializeSetupConfig } from './lib/setup-config';
import { actionsRequireWranglerAuth, parseSetupArgs, resolveSetupActions } from './lib/setup-cli';
import { createConsolePrompter, promptForSetup, type SetupPromptActions, type SetupPrompter } from './lib/setup-prompts';
import { checkSetupPrereqsWithOptions, checkWranglerAuthPrereq, type SetupPrereqResult } from './lib/setup-prereqs';
import { createBootstrapCommandOptions, createBootstrapEnv, findCreatedKey, parseBootstrapOutput } from './lib/setup-bootstrap';
import {
  deployAdminPages,
  deployApiWorker,
  ensurePagesProjectExists,
  getApiWranglerConfigPath,
  getAdminPagesProjectName
} from './lib/setup-deploy';
import { listDriveWatches, registerDriveWatches } from './lib/setup-drive-watches';
import {
  applyAdminApiBaseUrl,
  applyAdminSecrets,
  applyApiSecrets,
  collectAdminSiteSecrets,
  collectSetupSecrets,
  requireAdminSiteSecrets
} from './lib/setup-secrets';
import { createSmokeEnv } from './lib/setup-smoke';
import {
  createSetupLocalState,
  getSetupLocalStatePath,
  readSetupLocalState,
  type SetupLocalState,
  writeSetupLocalState
} from './lib/setup-state';
import {
  resolvePreferredAdminCredential,
  resolveSetupRuntimeState,
  summarizeSetupSecrets
} from './lib/setup-runtime';
import { getSetupDoctorFailureMessage, runSetupDoctor } from './lib/setup-doctor';
import { isPlaceholderGoogleClientEmail } from './lib/setup-google';
import { verifyAdminPagesDeployment } from './lib/setup-verify';
import { getCommandName, runCommand } from './lib/process';
import { ScriptError, getEnv, logSuccess, logStep } from './lib/runtime';

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
  localStatePath: string | null;
};

async function readConfigFile(path: string) {
  const text = await readFile(path, 'utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new ScriptError(`Setup config ${path} must contain valid JSON.`);
  }
}

function isMissingFileError(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function renderPrereqSummary(results: SetupPrereqResult[]) {
  for (const result of results) {
    let prefix = '[blocked]';
    if (result.status === 'ready') {
      prefix = '[ok]';
    } else if (result.status === 'warning') {
      prefix = '[warn]';
    }
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

function assertRealGoogleClientEmail(value: string | null) {
  if (!value) {
    throw new ScriptError('Deploy requires GOOGLE_CLIENT_EMAIL from setup secrets, local setup state, or the environment.');
  }

  if (isPlaceholderGoogleClientEmail(value)) {
    throw new ScriptError(
      `Deploy cannot use the checked-in placeholder GOOGLE_CLIENT_EMAIL (${value}). Run npm run setup -- --apply-secrets --provision-google, or provide a real GOOGLE_CLIENT_EMAIL before deploying.`
    );
  }

  return value;
}

async function runBootstrap(env: NodeJS.ProcessEnv) {
  const result = await runCommand(
    getCommandName('npm'),
    ['run', 'ops:bootstrap'],
    {
      cwd: resolve('.'),
      ...createBootstrapCommandOptions(env)
    }
  );
  if (result.code !== 0) {
    if (result.stderr.trim().length > 0) {
      process.stderr.write(result.stderr);
    }
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

async function persistLocalState(configPath: string, currentState: SetupLocalState | null, updates: SetupLocalState) {
  const nextState = {
    ...(currentState ?? {}),
    ...updates
  };
  await writeSetupLocalState(configPath, nextState);
  return nextState;
}

async function registerDriveWatchesIfPossible(options: {
  apiUrl: string | null;
  adminCredential: string | null;
  shouldRegister: boolean;
  failOnError?: boolean;
}) {
  if (!options.shouldRegister || !options.apiUrl || !options.adminCredential) {
    return null;
  }

  logStep('Registering Google Drive spreadsheet watches');
  try {
    const result = await registerDriveWatches({
      baseUrl: options.apiUrl,
      adminCredential: options.adminCredential
    });
    const verified = await listDriveWatches({
      baseUrl: options.apiUrl,
      adminCredential: options.adminCredential,
      retries: 2,
      retryDelayMs: 1000
    });
    const visibleSpreadsheetIds = new Set(verified.map((watch) => watch.spreadsheetId));
    const missingSpreadsheetIds = result
      .map((watch) => watch.spreadsheetId)
      .filter((spreadsheetId) => !visibleSpreadsheetIds.has(spreadsheetId));

    if (missingSpreadsheetIds.length > 0) {
      console.warn(
        `Warning: Drive watch registration returned success, but status has not yet confirmed spreadsheet watch visibility for ${missingSpreadsheetIds.join(', ')}. Re-check with npm run ops:watch:drive:status.`
      );
    } else {
      logSuccess(`Registered or renewed ${result.length} spreadsheet watch${result.length === 1 ? '' : 'es'}`);
    }
    return result;
  } catch (error) {
    if (options.failOnError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Failed to register Google Drive spreadsheet watches automatically: ${message}`);
    console.warn('Setup will continue. To retry watch registration later, run: npm run ops:watch:drive');
    return null;
  }
}

async function ensureAdminPagesProjectReady(profile: string) {
  const pagesProjectName = getAdminPagesProjectName(profile);
  const result = await ensurePagesProjectExists(pagesProjectName);
  if (result.created) {
    logSuccess(`Created Cloudflare Pages project ${pagesProjectName}`);
  }

  return pagesProjectName;
}

async function applyAdminPagesConfiguration(options: {
  adminUiPassword: string;
  adminUiUsername: string;
  apiUrl?: string | null;
  pagesProjectName: string;
}) {
  logStep('Applying admin Pages site secrets');
  await applyAdminSecrets({
    pagesProjectName: options.pagesProjectName,
    username: options.adminUiUsername,
    password: options.adminUiPassword
  });
  logSuccess('Admin site secrets applied');

  if (!options.apiUrl) {
    return;
  }

  logStep('Applying admin Pages API base URL');
  await applyAdminApiBaseUrl({
    apiBaseUrl: options.apiUrl,
    pagesProjectName: options.pagesProjectName
  });
  logSuccess('Admin Pages API base URL applied');
}

async function main() {
  const options = parseSetupArgs(process.argv.slice(2));
  const resolvedConfigPath = resolve(options.configPath);
  const localStatePath = getSetupLocalStatePath(resolvedConfigPath);

  if (options.writeDefaultConfig) {
    logStep(`Writing starter setup config to ${resolvedConfigPath}`);
    await writeFile(resolvedConfigPath, createDefaultSetupConfig(), 'utf8');
    logSuccess(`Starter config written to ${resolvedConfigPath}`);
    return;
  }

  logStep('Checking setup prerequisites');
  const prereqResults = await checkSetupPrereqsWithOptions({
    includeWranglerAuth: options.applySecrets || options.deploy || options.verify,
    includeGcloudAuth: options.provisionGoogle
  });
  renderPrereqSummary(prereqResults);

  const prompter = process.stdin.isTTY && process.stdout.isTTY
    ? createConsolePrompter()
    : null;
  let localState = await readSetupLocalState(resolvedConfigPath);
  let localStateWritten = false;
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
    logSuccess(`Validated setup config for profile ${config.profile} with private project ${config.privateProject.slug}.`);
    console.log(JSON.stringify({
      profile: config.profile,
      privateProject: config.privateProject.slug,
      publicReadProject: config.publicReadProject?.slug ?? null,
      privateTables: config.privateProject.tables.map((table) => table.tableSlug),
      publicReadTables: config.publicReadProject?.tables.map((table) => table.tableSlug) ?? []
    }, null, 2));

    const actions = resolveSetupActions(options, promptActions);

    if (!actions.applySecretsNow && !actions.deployNow && !actions.bootstrapNow && !actions.smokeNow && !options.verify) {
      return;
    }

    let wranglerResult = prereqResults.find((result) => result.name === 'Wrangler auth') ?? null;
    if (actionsRequireWranglerAuth(actions) && !wranglerResult) {
      wranglerResult = await checkWranglerAuthPrereq();
      renderPrereqSummary([wranglerResult]);
    }

    if (actionsRequireWranglerAuth(actions) && wranglerResult?.status === 'blocked') {
      throw new ScriptError('Wrangler authentication is required before applying secrets or deploying. Run npx wrangler login and rerun setup.');
    }

    const resolvedRuntimeState = resolveSetupRuntimeState(localState);
    let apiUrl: string | null = resolvedRuntimeState.apiUrl;
    let adminUrl: string | null = resolvedRuntimeState.adminUrl;
    let adminBearerToken: string | null = resolvedRuntimeState.adminBearerToken;
    let adminUiUsername: string | null = resolvedRuntimeState.adminUiUsername;
    let adminUiPassword: string | null = resolvedRuntimeState.adminUiPassword;
    let adminApiKey: string | null = resolvedRuntimeState.adminApiKey;
    let privateReadKey: string | null = resolvedRuntimeState.privateReadKey;
    let mutationKey: string | null = resolvedRuntimeState.mutationKey;

    let setupSecrets: Awaited<ReturnType<typeof collectSetupSecrets>> | null = null;
    if (actions.applySecretsNow) {
      logStep('Collecting setup secrets');
      setupSecrets = await collectSetupSecrets({
        prompter,
        includeAdminUiSecrets: config.deploy.admin,
        defaultAdminUiUsername: adminUiUsername,
        defaultAdminUiPassword: adminUiPassword,
        googleProvisioning: {
          enabled: options.provisionGoogle,
          profile: config.profile,
          projectId: options.googleProjectId,
          serviceAccountName: options.googleServiceAccountName
        }
      });
      adminBearerToken = setupSecrets.adminBearerToken;
      adminUiUsername = setupSecrets.adminUiUsername;
      adminUiPassword = setupSecrets.adminUiPassword;

      logStep('Applying Worker secrets');
      await applyApiSecrets({
        apiWranglerConfigPath: getApiWranglerConfigPath(config.profile),
        googlePrivateKey: setupSecrets.googlePrivateKey,
        driveWebhookSecret: setupSecrets.driveWebhookSecret,
        adminBearerToken: setupSecrets.adminBearerToken
      });
      logSuccess('Worker secrets applied');

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          googleClientEmail: setupSecrets.googleClientEmail,
          adminBearerToken: setupSecrets.adminBearerToken,
          adminUiUsername: setupSecrets.adminUiUsername,
          adminUiPassword: setupSecrets.adminUiPassword
        })
      });
      localStateWritten = true;

      if (config.deploy.admin && adminUiUsername && adminUiPassword && !actions.deployNow) {
        const adminSiteSecrets = requireAdminSiteSecrets({
          adminUiUsername,
          adminUiPassword
        });
        const pagesProjectName = await ensureAdminPagesProjectReady(config.profile);
        await applyAdminPagesConfiguration({
          adminUiPassword: adminSiteSecrets.adminUiPassword,
          adminUiUsername: adminSiteSecrets.adminUiUsername,
          apiUrl,
          pagesProjectName,
        });
      }
    }

    if (actions.deployNow) {
      const googleClientEmail = assertRealGoogleClientEmail(setupSecrets?.googleClientEmail
        ?? localState?.googleClientEmail
        ?? resolvedRuntimeState.googleClientEmail);

      logStep('Deploying API Worker');
      const apiDeploy = await deployApiWorker(config.profile, googleClientEmail);
      apiUrl = apiDeploy.url;
      logSuccess(`API deployed at ${apiUrl}`);

      if (config.deploy.admin) {
        const pagesProjectName = await ensureAdminPagesProjectReady(config.profile);
        if (!adminUiUsername || !adminUiPassword) {
          const adminSiteSecrets = await collectAdminSiteSecrets({
            prompter,
            defaultAdminUiUsername: adminUiUsername,
            defaultAdminUiPassword: adminUiPassword
          });
          adminUiUsername = adminSiteSecrets.adminUiUsername;
          adminUiPassword = adminSiteSecrets.adminUiPassword;
        }

        const adminSiteSecrets = requireAdminSiteSecrets({
          adminUiUsername,
          adminUiPassword
        });
        await applyAdminPagesConfiguration({
          adminUiPassword: adminSiteSecrets.adminUiPassword,
          adminUiUsername: adminSiteSecrets.adminUiUsername,
          apiUrl,
          pagesProjectName,
        });

        logStep('Deploying admin Pages site');
        const adminDeploy = await deployAdminPages(config.profile);
        adminUrl = adminDeploy.siteUrl;
        logSuccess(`Admin deployed at ${adminUrl}`);

        logStep('Verifying admin Pages site');
        await verifyAdminPagesDeployment({
          password: adminSiteSecrets.adminUiPassword,
          siteUrl: adminDeploy.siteUrl,
          username: adminSiteSecrets.adminUiUsername
        });
        logSuccess('Admin Pages site verified');
      }

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          googleClientEmail,
          apiUrl,
          adminUrl,
          adminBearerToken,
          adminUiUsername,
          adminUiPassword
        })
      });
      localStateWritten = true;
    }

    if (!apiUrl && (actions.bootstrapNow || actions.smokeNow)) {
      if (!prompter) {
        throw new ScriptError('Bootstrap or smoke requires SHEETFLARE_BASE_URL or a prior local setup state file when no fresh deploy was run.');
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
          throw new ScriptError('Bootstrap requires an admin credential from local setup state or environment.');
        }
        adminBearerToken = (await promptForText(prompter, {
          message: 'Admin bootstrap credential',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
      }

      logStep('Bootstrapping projects and API keys');
      const bootstrapOutput = await runBootstrap(createBootstrapEnv(config, apiUrl, adminBearerToken));
      if (config.smoke.enabled) {
        adminApiKey = findCreatedKey(bootstrapOutput, config.smoke.adminKeyName);
        privateReadKey = findCreatedKey(bootstrapOutput, config.smoke.privateReadKeyName);
        mutationKey = findCreatedKey(bootstrapOutput, config.smoke.mutationKeyName);
      }
      logSuccess('Bootstrap completed');

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          apiUrl,
          adminBearerToken,
          adminApiKey,
          privateReadKey,
          mutationKey
        })
      });
      localStateWritten = true;
    }

    const setupAdminCredential = resolvePreferredAdminCredential({
      adminApiKey,
      adminBearerToken
    });
    await registerDriveWatchesIfPossible({
      apiUrl,
      adminCredential: setupAdminCredential,
      shouldRegister: actions.deployNow || actions.bootstrapNow
    });

    if (actions.smokeNow) {
      if (!config.smoke.enabled) {
        throw new ScriptError('Smoke is disabled in sheetflare.setup.json. Set smoke.enabled to true or rerun setup with a smoke-enabled config.');
      }
      if (!apiUrl) {
        throw new ScriptError('API base URL is required for smoke.');
      }

      let smokeAdminCredential = resolvePreferredAdminCredential({
        adminApiKey,
        adminBearerToken
      });
      if (!smokeAdminCredential) {
        if (!prompter) {
          throw new ScriptError('Smoke requires an admin API key or admin credential from local setup state or environment.');
        }
        adminApiKey = (await promptForText(prompter, {
          message: 'Admin API key for smoke',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
        smokeAdminCredential = adminApiKey;
      }
      if (!privateReadKey) {
        if (!prompter) {
          throw new ScriptError('Smoke requires a private read key from local setup state or environment.');
        }
        privateReadKey = (await promptForText(prompter, {
          message: 'Private read API key for smoke'
        })).trim();
      }
      if (!mutationKey) {
        if (!prompter) {
          throw new ScriptError('Smoke requires a mutation API key from local setup state or environment.');
        }
        mutationKey = (await promptForText(prompter, {
          message: 'Mutation API key for smoke'
        })).trim();
      }

      logStep('Running smoke validation');
      await runSmoke(createSmokeEnv({
        config,
        baseUrl: apiUrl,
        adminCredential: smokeAdminCredential,
        privateReadKey,
        mutationKey
      }));
      logSuccess('Smoke validation completed');
    }

    printExecutionSummary({
      configPath: resolvedConfigPath,
      apiUrl,
      adminUrl,
      ...summarizeSetupSecrets({
        showSecrets: options.showSecrets,
        localStatePath: localStateWritten ? localStatePath : null,
        adminBearerToken,
        adminUiUsername,
        adminUiPassword,
        adminApiKey,
        privateReadKey,
        mutationKey
      })
    });

    if (options.verify) {
      logStep('Verifying setup-managed environment');
      const verificationResults = await runSetupDoctor({
        config,
        runtimeState: resolveSetupRuntimeState(localState),
        prereqResults
      });
      renderPrereqSummary(verificationResults);

      const verificationFailureMessage = getSetupDoctorFailureMessage(verificationResults);
      if (verificationFailureMessage) {
        throw new ScriptError(verificationFailureMessage);
      }

      logSuccess('Setup verification completed without warnings or blocking issues');
    }
  } finally {
    prompter?.close?.();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
