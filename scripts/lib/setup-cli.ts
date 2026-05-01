import type { SetupPromptActions } from './setup-prompts';
import { ScriptError } from './runtime';

export type SetupCliOptions = {
  configPath: string;
  writeDefaultConfig: boolean;
  applySecrets: boolean;
  deploy: boolean;
  bootstrap: boolean;
  smoke: boolean;
  showSecrets: boolean;
  provisionGoogle: boolean;
  googleProjectId: string | null;
  googleServiceAccountName: string | null;
};

export function createDefaultSetupCliOptions(): SetupCliOptions {
  return {
    configPath: 'sheetflare.setup.json',
    writeDefaultConfig: false,
    applySecrets: false,
    deploy: false,
    bootstrap: false,
    smoke: false,
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
