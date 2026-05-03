import type { SetupPromptActions } from './setup-prompts';
import { ScriptError } from './runtime';

export type SetupCliOptions = {
  configPath: string;
  help: boolean;
  writeDefaultConfig: boolean;
  applySecrets: boolean;
  deploy: boolean;
  bootstrap: boolean;
  smoke: boolean;
  verify: boolean;
  showSecrets: boolean;
  provisionGoogle: boolean;
  googleProjectId: string | null;
  googleServiceAccountName: string | null;
};

export function createDefaultSetupCliOptions(): SetupCliOptions {
  return {
    configPath: 'sheetflare.setup.json',
    help: false,
    writeDefaultConfig: false,
    applySecrets: false,
    deploy: false,
    bootstrap: false,
    smoke: false,
    verify: false,
    showSecrets: false,
    provisionGoogle: false,
    googleProjectId: null,
    googleServiceAccountName: null
  };
}

export function parseSetupArgs(argv: string[]): SetupCliOptions {
  const options = createDefaultSetupCliOptions();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      return options;
    }

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

    if (argument === '--apply-secrets') {
      options.applySecrets = true;
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

    if (argument === '--verify') {
      options.verify = true;
      continue;
    }

    if (argument === '--show-secrets') {
      options.showSecrets = true;
      continue;
    }

    if (argument === '--provision-google') {
      options.provisionGoogle = true;
      continue;
    }

    if (argument === '--google-project') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new ScriptError('Missing value for --google-project.');
      }
      options.googleProjectId = nextValue;
      index += 1;
      continue;
    }

    if (argument === '--google-service-account') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new ScriptError('Missing value for --google-service-account.');
      }
      options.googleServiceAccountName = nextValue;
      index += 1;
      continue;
    }

    throw new ScriptError(`Unknown setup argument: ${argument}`);
  }

  return options;
}

export function renderSetupHelp() {
  return `
Usage: npm run setup -- [options]

Runs the Sheetflare operator setup flow. With no options, setup prompts for a
configuration and writes sheetflare.setup.json. Add action flags to apply
secrets, deploy, bootstrap projects and keys, smoke-test, or verify an existing
deployment.

Common flows:
  npm run setup
  npm run setup -- --apply-secrets
  npm run setup -- --apply-secrets --provision-google
  npm run setup -- --deploy --bootstrap --smoke --verify
  npm run setup -- --verify
  npm run doctor

Options:
  -h, --help                         Show this help.
  --config <path>                    Use a setup config path. Default: sheetflare.setup.json.
  --write-default-config             Write a starter setup config and exit.
  --apply-secrets                    Apply Worker and admin Pages secrets.
  --deploy                           Deploy the API Worker and admin Pages site.
  --bootstrap                        Bootstrap projects, tables, and API keys.
  --smoke                            Run smoke validation after setup/bootstrap.
  --verify                           Run setup verification/doctor checks.
  --show-secrets                     Show generated secrets in the final summary.
  --provision-google                 Provision Google service-account resources with gcloud.
  --google-project <id>              Google Cloud project id for provisioning.
  --google-service-account <name>    Google service-account name for provisioning.
`.trim();
}

export function resolveSetupActions(
  options: SetupCliOptions,
  promptActions: SetupPromptActions | null
): SetupPromptActions {
  if (promptActions) {
    return promptActions;
  }

  return {
    applySecretsNow: options.applySecrets,
    deployNow: options.deploy,
    bootstrapNow: options.bootstrap,
    smokeNow: options.smoke
  };
}

export function actionsRequireWranglerAuth(actions: SetupPromptActions) {
  return actions.applySecretsNow || actions.deployNow;
}
