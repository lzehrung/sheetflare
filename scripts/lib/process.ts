import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

type ProcessTermination = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export function getCommandName(base: string) {
  return process.platform === 'win32' ? `${base}.cmd` : base;
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
    stdio: 'inherit'
  });
}

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    echoStdout?: boolean;
    echoStderr?: boolean;
  }
) {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: {
      ...process.env,
      ...options?.env
    },
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

function waitForChildTermination(child: ChildProcess): Promise<ProcessTermination> {
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

export async function killProcessTree(pid: number) {
  if (Number.isNaN(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    const taskkill = spawn(getCommandName('taskkill'), ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore'
    });
    await once(taskkill, 'exit');
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
