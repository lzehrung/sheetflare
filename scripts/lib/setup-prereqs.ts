import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { getCommandName } from './process';

const execFileAsync = promisify(execFile);
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
  commandRunner?: (command: string, args: string[]) => Promise<CommandResult>;
  pathExists?: (path: string) => Promise<boolean>;
  moduleResolver?: (specifier: string) => void;
};

type SetupPrereqOptions = {
  includeWranglerAuth?: boolean;
};

async function defaultCommandRunner(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8'
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    const execError = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof execError.code === 'number' ? execError.code : 1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message ?? ''
    };
  }
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
  return checkSetupPrereqsWithOptions({ includeWranglerAuth: true }, dependencies);
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

  return results;
}
