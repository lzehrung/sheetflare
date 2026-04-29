import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDefaultSetupConfig, parseSetupConfig, serializeSetupConfig } from './lib/setup-config';
import { createConsolePrompter, promptForSetup } from './lib/setup-prompts';
import { checkSetupPrereqs } from './lib/setup-prereqs';
import { ScriptError, logSuccess, logStep } from './lib/runtime';

type SetupCliOptions = {
  configPath: string;
  writeDefaultConfig: boolean;
};

function parseArgs(argv: string[]): SetupCliOptions {
  const options: SetupCliOptions = {
    configPath: 'sheetflare.setup.json',
    writeDefaultConfig: false
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

  let configInput: unknown;
  try {
    logStep(`Loading setup config ${resolvedConfigPath}`);
    configInput = await readConfigFile(resolvedConfigPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new ScriptError(`Setup config ${resolvedConfigPath} does not exist, and interactive setup requires a TTY. Use --write-default-config to create a starter config.`);
    }

    logStep(`No setup config found at ${resolvedConfigPath}; starting interactive setup`);
    const prompter = createConsolePrompter();
    try {
      const promptResult = await promptForSetup(prompter);
      configInput = promptResult.config;
      logStep(`Writing setup config ${resolvedConfigPath}`);
      await writeFile(resolvedConfigPath, serializeSetupConfig(promptResult.config), 'utf8');
      logSuccess(`Setup config written to ${resolvedConfigPath}`);
      console.log(JSON.stringify({
        actions: promptResult.actions
      }, null, 2));
    } finally {
      prompter.close?.();
    }
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
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
