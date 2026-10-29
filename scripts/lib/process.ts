import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

type TerminableProcess = Pick<EventEmitter, 'once' | 'removeListener'>;

type ProcessTermination = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export function shouldUseWindowsShell(command: string, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

export function getCommandName(base: string) {
  return process.platform === 'win32' ? `${base}.cmd` : base;
}

export type CommandRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  echoStdout?: boolean;
  echoStderr?: boolean;
};

export type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunOptions
) => Promise<CommandResult>;

const commandRunnerStore = new AsyncLocalStorage<CommandRunner>();

export function withCommandRunner<T>(runner: CommandRunner, fn: () => T): T {
  return commandRunnerStore.run(runner, fn);
}

export function spawnCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
) : ChildProcess {
  return spawn(command, args, {
    cwd: options?.cwd,
    env: {
      ...process.env,
      ...options?.env
    },
    ...(shouldUseWindowsShell(command) ? { shell: true } : {}),
    stdio: 'inherit'
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options?: CommandRunOptions
): Promise<CommandResult> {
  const override = commandRunnerStore.getStore();
  if (override) {
    return override(command, args, options);
  }

  return runSpawnedCommand(command, args, options);
}

async function runSpawnedCommand(
  command: string,
  args: string[],
  options?: CommandRunOptions
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: {
      ...process.env,
      ...options?.env
    },
    ...(shouldUseWindowsShell(command) ? { shell: true } : {}),
    stdio: 'pipe'
  });

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    stdout += text;
    if (options?.echoStdout !== false) {
      process.stdout.write(text);
    }
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderr += text;
    if (options?.echoStderr !== false) {
      process.stderr.write(text);
    }
  });

  if (options?.input !== undefined) {
    child.stdin?.write(options.input);
  }
  child.stdin?.end();

  const { code, signal, error } = await waitForChildTermination(child);
  if (error) {
    const suffix = error.message.endsWith('\n') ? error.message : `${error.message}\n`;
    stderr = stderr.length > 0 ? `${stderr}${suffix}` : suffix;
    if (options?.echoStderr !== false) {
      process.stderr.write(suffix);
    }
  }

  return {
    code,
    signal,
    stdout,
    stderr
  };
}

export async function waitForProcessExit(child: ChildProcess) {
  const { code, signal } = await waitForChildTermination(child);
  return { code, signal };
}

function waitForChildTermination(child: TerminableProcess): Promise<ProcessTermination> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: ProcessTermination) => {
      if (settled) {
        return;
      }

      settled = true;
      child.removeListener('exit', handleExit);
      child.removeListener('error', handleError);
      resolve(result);
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal });
    };

    const handleError = (error: Error) => {
      finish({
        code: 1,
        signal: null,
        error
      });
    };

    child.once('exit', handleExit);
    child.once('error', handleError);
  });
}

export type KillProcessTreeOptions = {
  platform?: NodeJS.Platform;
  /** Process spawner for taskkill; defaults to child_process.spawn. Injectable so tests need no real taskkill. */
  spawnProcess?: (command: string, args: readonly string[], options: { stdio: 'ignore' }) => TerminableProcess;
};

export async function killProcessTree(pid: number, options: KillProcessTreeOptions = {}) {
  if (Number.isNaN(pid)) {
    return;
  }

  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;

  if (platform === 'win32') {
    // taskkill ships only as taskkill.exe; a .cmd name fails to spawn. A failed spawn emits `error`
    // with no `exit`, so settle on whichever arrives first rather than hanging cleanup.
    const taskkill = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    await waitForChildTermination(taskkill);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
}
