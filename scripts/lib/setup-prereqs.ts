import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { checkGcloudAuthPrereq } from './setup-google';
import { getCommandName, runCommand } from './process';
const setupPrereqRequire = createRequire(import.meta.url);

export type SetupPrereqStatus = 'ready' | 'warning' | 'blocked';

export type SetupPrereqResult = {
  name: string;
  status: SetupPrereqStatus;
  summary: string;
  remediation: string | null;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type SetupPrereqDependencies = {
  commandRunner?: (command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    echoStdout?: boolean;
    echoStderr?: boolean;
  }) => Promise<CommandResult>;
  pathExists?: (path: string) => Promise<boolean>;
  moduleResolver?: (specifier: string) => void;
};

type SetupPrereqOptions = {
  includeWranglerAuth?: boolean;
  includeGcloudAuth?: boolean;
  debug?: boolean;
};

export async function runPrereqCommand(command: string, args: string[]) {
  const result = await runCommand(command, args, {
    echoStdout: false,
    echoStderr: false
  });
  return {
    code: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function defaultCommandRunner(command: string, args: string[]) {
  return runPrereqCommand(command, args);
}

async function defaultPathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultModuleResolver(specifier: string) {
  resolveModuleSpecifier(specifier);
}

export function resolveModuleSpecifier(specifier: string) {
  return setupPrereqRequire.resolve(specifier);
}

export async function checkSetupPrereqs(dependencies: SetupPrereqDependencies = {}) {
  return checkSetupPrereqsWithOptions({ includeWranglerAuth: true, includeGcloudAuth: false }, dependencies);
}

export async function checkWranglerAuthPrereq(dependencies: SetupPrereqDependencies = {}) {
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const wranglerResult = await commandRunner(getCommandName('npx'), ['wrangler', 'whoami']);
  if (wranglerResult.code === 0) {
    return {
      name: 'Wrangler auth',
      status: 'ready',
      summary: 'Wrangler authentication is available for deploy steps.',
      remediation: null
    } satisfies SetupPrereqResult;
  }

  return {
    name: 'Wrangler auth',
    status: 'blocked',
    summary: 'Wrangler is not authenticated on this machine.',
    remediation: 'Run npx wrangler login before applying secrets or deploying.'
  } satisfies SetupPrereqResult;
}

export async function checkSetupPrereqsWithOptions(
  options: SetupPrereqOptions = {},
  dependencies: SetupPrereqDependencies = {}
) {
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const moduleResolver = dependencies.moduleResolver ?? defaultModuleResolver;

  const results: SetupPrereqResult[] = [];

  const packageLockExists = await pathExists('package-lock.json');
  const nodeModulesExists = await pathExists('node_modules');
  try {
    moduleResolver('@sheetflare/contracts');
    if (packageLockExists && nodeModulesExists) {
      results.push({
        name: 'Repo install',
        status: 'ready',
        summary: 'Workspace dependencies are available.',
        remediation: null
      });
    } else {
      results.push({
        name: 'Repo install',
        status: 'warning',
        summary: 'Workspace dependencies resolve, but package-lock.json or node_modules was not found in the expected place.',
        remediation: 'Run npm install from the repository root if script resolution behaves unexpectedly.'
      });
    }
  } catch {
    results.push({
      name: 'Repo install',
      status: 'blocked',
      summary: 'Workspace dependencies are not installed.',
      remediation: 'Run npm install from the repository root before setup.'
    });
  }

  if (options.includeWranglerAuth ?? true) {
    results.push(await checkWranglerAuthPrereq({ commandRunner }));
  }

  if (options.includeGcloudAuth) {
    results.push(await checkGcloudAuthPrereq({
      commandRunner,
      debug: Boolean(options.debug)
    }));
  }

  return results;
}
