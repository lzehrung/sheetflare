import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDefaultSetupConfig, parseSetupConfig } from './lib/setup-config';
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolvedConfigPath = resolve(options.configPath);

  if (options.writeDefaultConfig) {
    logStep(`Writing starter setup config to ${resolvedConfigPath}`);
    await writeFile(resolvedConfigPath, createDefaultSetupConfig(), 'utf8');
    logSuccess(`Starter config written to ${resolvedConfigPath}`);
    return;
  }

  logStep(`Validating setup config ${resolvedConfigPath}`);
  const config = parseSetupConfig(await readConfigFile(resolvedConfigPath));
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

  throw new ScriptError('Interactive setup is not implemented yet. Use --write-default-config to create a starter config, then rerun with --config to validate it.');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
