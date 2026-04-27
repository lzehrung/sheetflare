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
