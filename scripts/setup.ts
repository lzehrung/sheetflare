import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDefaultSetupConfig, parseSetupConfig, serializeSetupConfig, setupConfigUsesDefaultGoogleCredential } from './lib/setup-config';
import { actionsRequireWranglerAuth, parseSetupArgs, renderSetupHelp, resolveSetupActions } from './lib/setup-cli';
import { confirmSheetShared, createConsolePrompter, promptForSetup, type SetupPromptActions, type SetupPrompter } from './lib/setup-prompts';
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
  hasDefaultGoogleCredentialEnvironment,
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
  mergeSetupRuntimeState,
  summarizeSetupSecrets,
  type SetupSecretsSummary
} from './lib/setup-runtime';
import { getSetupDoctorFailureMessage, runSetupDoctor } from './lib/setup-doctor';
import { checkGcloudAuthPrereq, isPlaceholderGoogleClientEmail } from './lib/setup-google';
import { formatBeginnerSetupNextSteps, formatSheetShareInstruction } from './lib/setup-next-steps';
import { verifyAdminPagesDeployment } from './lib/setup-verify';
import { getCommandName, runCommand } from './lib/process';
import { ScriptError, getEnv, logSuccess, logStep } from './lib/runtime';

type SetupExecutionSummary = {
  configPath: string;
  apiUrl: string | null;
  adminUrl: string | null;
} & SetupSecretsSummary;

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
    let prefix = 'Needs attention';
    if (result.status === 'ready') {
      prefix = 'Ready';
    } else if (result.status === 'warning') {
      prefix = 'Note';
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

function formatWranglerAuthRequiredMessage(beginnerSetupStarted: boolean) {
  if (beginnerSetupStarted) {
    return 'Wrangler authentication is required before applying secrets or deploying. Run npx wrangler login, then rerun npm run setup -- --apply-secrets --deploy --bootstrap --smoke --verify.';
  }

  return 'Wrangler authentication is required before applying secrets or deploying. Run npx wrangler login, then rerun setup with the same flags.';
}

function assertRealGoogleClientEmail(value: string | null) {
  if (!value) {
    throw new ScriptError(
      'Deploy needs a real Google service-account email. Run npm run setup -- --apply-secrets --provision-google, set GOOGLE_APPLICATION_CREDENTIALS, or set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY before deploying.'
    );
  }

  if (isPlaceholderGoogleClientEmail(value)) {
    throw new ScriptError(
      `Deploy cannot use the checked-in placeholder GOOGLE_CLIENT_EMAIL (${value}). Run npm run setup -- --apply-secrets --provision-google, or set GOOGLE_CLIENT_EMAIL to the real service-account email before deploying.`
    );
  }

  return value;
}

function hasUsableGoogleClientEmail(value: string | null | undefined) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !isPlaceholderGoogleClientEmail(value);
}

function hasSetupGoogleCredential(localState: SetupLocalState | null) {
  return hasUsableGoogleClientEmail(localState?.googleClientEmail)
    || hasDefaultGoogleCredentialEnvironment();
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
    if (result.stdout.trim().length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.trim().length > 0) {
      process.stderr.write(result.stderr);
    }
    throw new ScriptError(
      'Bootstrap failed. Confirm the spreadsheet is shared with the Google service-account email as Editor, the configured tab exists, the _id header exists, and existing _id values are unique and non-blank.'
    );
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
    if (result.stdout.trim().length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.trim().length > 0) {
      process.stderr.write(result.stderr);
    }
    throw new ScriptError(
      'Smoke validation failed. Confirm the configured smoke column exists in the sheet, is not the _id column, and can be written by the API.'
    );
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

async function ensureAdminPagesProjectReady(profile: string, options: { debug?: boolean } = {}) {
  const pagesProjectName = getAdminPagesProjectName(profile);
  const result = await ensurePagesProjectExists(pagesProjectName, options);
  if (result.created) {
    logSuccess(`Created Cloudflare Pages project ${pagesProjectName}`);
  }

  return pagesProjectName;
}

async function applyAdminPagesConfiguration(options: {
  adminUiPassword: string;
  adminUiUsername: string;
  apiUrl?: string | null;
  debug?: boolean;
  pagesProjectName: string;
}) {
  logStep('Saving admin site sign-in secrets');
  await applyAdminSecrets({
    debug: Boolean(options.debug),
    pagesProjectName: options.pagesProjectName,
    username: options.adminUiUsername,
    password: options.adminUiPassword
  });
  logSuccess('Admin site sign-in secrets saved');

  if (!options.apiUrl) {
    return;
  }

  logStep('Connecting the admin site to the API');
  await applyAdminApiBaseUrl({
    apiBaseUrl: options.apiUrl,
    debug: Boolean(options.debug),
    pagesProjectName: options.pagesProjectName
  });
  logSuccess('Admin site API URL saved');
}

async function main() {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    console.log(renderSetupHelp());
    return;
  }

  const resolvedConfigPath = resolve(options.configPath);
  const localStatePath = getSetupLocalStatePath(resolvedConfigPath);

  if (options.writeDefaultConfig) {
    logStep(`Writing starter setup file to ${resolvedConfigPath}`);
    await writeFile(resolvedConfigPath, createDefaultSetupConfig(), 'utf8');
    logSuccess(`Starter setup file written to ${resolvedConfigPath}`);
    return;
  }

  let provisionGoogle = options.provisionGoogle;

  logStep('Checking your computer');
  const prereqResults = await checkSetupPrereqsWithOptions({
    includeWranglerAuth: options.applySecrets || options.deploy || options.verify,
    includeGcloudAuth: provisionGoogle,
    debug: options.debug
  });
  renderPrereqSummary(prereqResults);

  const prompter = process.stdin.isTTY && process.stdout.isTTY
    ? createConsolePrompter()
    : null;
  let localState = await readSetupLocalState(resolvedConfigPath);
  let localStateWritten = false;
  let configInput: unknown;
  let promptActions: SetupPromptActions | null = null;
  let beginnerSetupStarted = false;

  try {
    try {
      logStep(`Looking for setup config at ${resolvedConfigPath}`);
      configInput = await readConfigFile(resolvedConfigPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      if (!prompter) {
        throw new ScriptError(`Setup config ${resolvedConfigPath} does not exist, and interactive setup requires a TTY. Use --write-default-config to create a starter config.`);
      }

      logStep(`No setup config found at ${resolvedConfigPath}; we will create one together`);
      const promptMode = options.advanced ? 'advanced' : 'beginner';
      beginnerSetupStarted = promptMode === 'beginner';
      const promptResult = await promptForSetup(prompter, {
        mode: promptMode,
        googleCredentialAvailable: hasSetupGoogleCredential(localState)
      });
      if (promptResult.provisionGoogle && !provisionGoogle) {
        provisionGoogle = true;
        const gcloudResult = await checkGcloudAuthPrereq({ debug: options.debug });
        prereqResults.push(gcloudResult);
        renderPrereqSummary([gcloudResult]);
        if (gcloudResult.status === 'blocked') {
          throw new ScriptError(gcloudResult.remediation);
        }
      }
      promptActions = promptResult.actions;
      configInput = promptResult.config;
      logStep(`Saving setup choices to ${resolvedConfigPath}`);
      await writeFile(resolvedConfigPath, serializeSetupConfig(promptResult.config), 'utf8');
      logSuccess(`Setup choices saved to ${resolvedConfigPath}`);
    }

    logStep('Checking setup choices');
    const config = parseSetupConfig(configInput);
    const tableCount = config.privateProject.tables.length + (config.publicReadProject?.tables.length ?? 0);
    logSuccess(`Setup choices look valid for project ${config.privateProject.slug} with ${tableCount} table${tableCount === 1 ? '' : 's'}.`);

    const actions = resolveSetupActions(options, promptActions);

    if (!actions.applySecretsNow && !actions.deployNow && !actions.bootstrapNow && !actions.smokeNow && !actions.verifyNow) {
      return;
    }

    let wranglerResult = prereqResults.find((result) => result.name === 'Wrangler auth') ?? null;
    if (actionsRequireWranglerAuth(actions) && !wranglerResult) {
      wranglerResult = await checkWranglerAuthPrereq();
      renderPrereqSummary([wranglerResult]);
    }

    if (actionsRequireWranglerAuth(actions) && wranglerResult?.status === 'blocked') {
      throw new ScriptError(formatWranglerAuthRequiredMessage(beginnerSetupStarted));
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
      logStep('Preparing credentials');
      setupSecrets = await collectSetupSecrets({
        prompter,
        includeAdminUiSecrets: config.deploy.admin,
        defaultAdminUiUsername: adminUiUsername,
        defaultAdminUiPassword: adminUiPassword,
        googleProvisioning: {
          enabled: provisionGoogle,
          profile: config.profile,
          projectId: options.googleProjectId,
          serviceAccountName: options.googleServiceAccountName,
          allowInteractivePrompt: !beginnerSetupStarted,
          promptForDetails: !beginnerSetupStarted,
          debug: options.debug
        }
      });
      adminBearerToken = setupSecrets.adminBearerToken;
      adminUiUsername = setupSecrets.adminUiUsername;
      adminUiPassword = setupSecrets.adminUiPassword;

      logStep('Saving API secrets to Cloudflare');
      await applyApiSecrets({
        apiWranglerConfigPath: getApiWranglerConfigPath(config.profile),
        debug: options.debug,
        googlePrivateKey: setupSecrets.googlePrivateKey,
        driveWebhookSecret: setupSecrets.driveWebhookSecret,
        adminBearerToken: setupSecrets.adminBearerToken
      });
      logSuccess('API secrets saved');

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          googleClientEmail: setupSecrets.googleClientEmail,
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
        const pagesProjectName = await ensureAdminPagesProjectReady(config.profile, { debug: options.debug });
        await applyAdminPagesConfiguration({
          adminUiPassword: adminSiteSecrets.adminUiPassword,
          adminUiUsername: adminSiteSecrets.adminUiUsername,
          apiUrl,
          debug: options.debug,
          pagesProjectName,
        });
      }
    }

    if (actions.deployNow) {
      const googleClientEmail = setupConfigUsesDefaultGoogleCredential(config)
        ? assertRealGoogleClientEmail(setupSecrets?.googleClientEmail
          ?? localState?.googleClientEmail
          ?? resolvedRuntimeState.googleClientEmail)
        : null;

      logStep('Deploying the API');
      const apiDeploy = await deployApiWorker(config.profile, googleClientEmail, { debug: options.debug });
      apiUrl = apiDeploy.url;
      logSuccess(`API is live at ${apiUrl}`);

      if (config.deploy.admin) {
        const pagesProjectName = await ensureAdminPagesProjectReady(config.profile, { debug: options.debug });
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
          debug: options.debug,
          pagesProjectName,
        });

        logStep('Deploying the admin site');
        const adminDeploy = await deployAdminPages(config.profile, { debug: options.debug });
        adminUrl = adminDeploy.siteUrl;
        logSuccess(`Admin site is live at ${adminUrl}`);

        logStep('Checking the admin site');
        await verifyAdminPagesDeployment({
          password: adminSiteSecrets.adminUiPassword,
          siteUrl: adminDeploy.siteUrl,
          username: adminSiteSecrets.adminUiUsername
        });
        logSuccess('Admin site is reachable');
      }

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          googleClientEmail: googleClientEmail ?? undefined,
          apiUrl,
          adminUrl,
          adminUiUsername,
          adminUiPassword
        })
      });
      localStateWritten = true;
    }

    if (beginnerSetupStarted && (actions.bootstrapNow || actions.smokeNow)) {
      const shareEmail = setupSecrets?.googleClientEmail
        ?? localState?.googleClientEmail
        ?? resolvedRuntimeState.googleClientEmail;
      console.log('');
      console.log(formatSheetShareInstruction(shareEmail));
      if (prompter) {
        await confirmSheetShared(prompter);
      }
    }

    if (!apiUrl && (actions.bootstrapNow || actions.smokeNow)) {
      if (!prompter) {
        throw new ScriptError('Bootstrap or smoke needs the deployed API URL. Rerun setup after deploy, or set SHEETFLARE_BASE_URL to the Worker URL.');
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
          throw new ScriptError('Bootstrap needs an admin credential. Set SHEETFLARE_ADMIN_CREDENTIAL to the bootstrap admin token or run setup interactively.');
        }
        adminBearerToken = (await promptForText(prompter, {
          message: 'Admin bootstrap credential',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
      }

      logStep('Creating projects and API keys');
      const bootstrapOutput = await runBootstrap(createBootstrapEnv(config, apiUrl, adminBearerToken));
      if (config.smoke.enabled) {
        adminApiKey = findCreatedKey(bootstrapOutput, config.smoke.adminKeyName);
        privateReadKey = findCreatedKey(bootstrapOutput, config.smoke.privateReadKeyName);
        mutationKey = findCreatedKey(bootstrapOutput, config.smoke.mutationKeyName);
      }
      logSuccess('Projects and API keys are ready');

      localState = await persistLocalState(resolvedConfigPath, localState, {
        ...createSetupLocalState({
          apiUrl
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
          throw new ScriptError('Smoke validation needs an admin credential. Set SHEETFLARE_ADMIN_CREDENTIAL to an admin API key or the bootstrap admin token.');
        }
        adminApiKey = (await promptForText(prompter, {
          message: 'Admin API key for smoke',
          envName: 'SHEETFLARE_ADMIN_CREDENTIAL'
        })).trim();
        smokeAdminCredential = adminApiKey;
      }
      if (!privateReadKey) {
        if (!prompter) {
          throw new ScriptError('Smoke validation needs a private read API key. Set SHEETFLARE_PRIVATE_READ_KEY or run setup interactively after bootstrap.');
        }
        privateReadKey = (await promptForText(prompter, {
          message: 'Private read API key for smoke'
        })).trim();
      }
      if (!mutationKey) {
        if (!prompter) {
          throw new ScriptError('Smoke validation needs a mutation API key. Set SHEETFLARE_MUTATION_KEY or run setup interactively after bootstrap.');
        }
        mutationKey = (await promptForText(prompter, {
          message: 'Mutation API key for smoke'
        })).trim();
      }

      logStep('Testing the API with your sheet');
      await runSmoke(createSmokeEnv({
        config,
        baseUrl: apiUrl,
        adminCredential: smokeAdminCredential,
        privateReadKey,
        mutationKey
      }));
      logSuccess('Sheet read/write test passed');
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

    if (actions.verifyNow) {
      logStep('Checking the finished setup');
      const verificationRuntimeState = mergeSetupRuntimeState(resolveSetupRuntimeState(localState), {
        googleClientEmail: setupSecrets?.googleClientEmail
          ?? localState?.googleClientEmail
          ?? resolvedRuntimeState.googleClientEmail,
        apiUrl,
        adminUrl,
        adminBearerToken,
        adminUiUsername,
        adminUiPassword,
        adminApiKey,
        privateReadKey,
        mutationKey
      });
      const verificationResults = await runSetupDoctor({
        config,
        runtimeState: verificationRuntimeState,
        prereqResults
      });
      renderPrereqSummary(verificationResults);

      const verificationFailureMessage = getSetupDoctorFailureMessage(verificationResults);
      if (verificationFailureMessage) {
        throw new ScriptError(verificationFailureMessage);
      }

      logSuccess('Setup checks passed');
    }

    if (beginnerSetupStarted) {
      console.log('');
      for (const line of formatBeginnerSetupNextSteps({
        googleClientEmail: setupSecrets?.googleClientEmail
          ?? localState?.googleClientEmail
          ?? resolvedRuntimeState.googleClientEmail,
        apiUrl,
        adminUrl
      })) {
        console.log(line);
      }
    }
  } finally {
    prompter?.close?.();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
