import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

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

  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return {
    code,
    signal,
    stdout,
    stderr
  };
}

export async function waitForProcessExit(child: ChildProcess) {
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  return { code, signal };
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
