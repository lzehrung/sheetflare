import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { killProcessTree, runCommand, shouldUseWindowsShell } from './process';
import { withProcessEnv } from './runtime';

type SpawnCall = { command: string; args: readonly string[] };

const childEnvProbe = "process.stdout.write(JSON.stringify({ token: process.env.CLOUDFLARE_API_TOKEN ?? null, hostOnly: process.env.SHEETFLARE_TEST_HOST_ONLY ?? null, path: process.env.PATH ?? null }))";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

/**
 * Stands in for child_process.spawn (an external boundary). killProcessTree only listens for
 * `exit`/`error`, so an EventEmitter that fires the chosen event is the whole contract.
 */
function createSpawnRecorder(event: 'exit' | 'error') {
  const calls: SpawnCall[] = [];
  const spawnProcess = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (event === 'error') {
        child.emit('error', new Error('spawn taskkill.exe ENOENT'));
        return;
      }
      child.emit('exit', 0, null);
    });
    return child;
  };
  return { calls, spawnProcess };
}

describe('process helpers', () => {
  it('routes Windows .cmd and .bat commands through the shell', () => {
    expect(shouldUseWindowsShell('npx.cmd', 'win32')).toBe(true);
    expect(shouldUseWindowsShell('npm.bat', 'win32')).toBe(true);
    expect(shouldUseWindowsShell('node.exe', 'win32')).toBe(false);
    expect(shouldUseWindowsShell('npx.cmd', 'linux')).toBe(false);
  });

  it('returns a non-zero result instead of hanging when spawn emits an error', async () => {
    const result = await runCommand('sheetflare-command-that-does-not-exist-anywhere', [], {
      echoStdout: false,
      echoStderr: false
    });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('captures normal command output', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], {
      echoStdout: false,
      echoStderr: false
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('ok');
    expect(result.stderr).toBe('');
  });

  it('runs real children under the injected env without leaking host-only variables', async () => {
    const previous = {
      token: process.env.CLOUDFLARE_API_TOKEN,
      hostOnly: process.env.SHEETFLARE_TEST_HOST_ONLY
    };
    process.env.CLOUDFLARE_API_TOKEN = 'host-cloudflare-token';
    process.env.SHEETFLARE_TEST_HOST_ONLY = 'host-only-value';
    const hostPath = process.env.PATH ?? process.env.Path ?? '';
    try {
      // Same scoping runSetup applies for deps.env; the injected env deliberately omits PATH.
      const result = await withProcessEnv({ CLOUDFLARE_API_TOKEN: 'injected-cloudflare-token' }, () =>
        runCommand(process.execPath, ['-e', childEnvProbe], { echoStdout: false, echoStderr: false })
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        token: 'injected-cloudflare-token',
        hostOnly: null,
        path: hostPath
      });
    } finally {
      restoreEnv('CLOUDFLARE_API_TOKEN', previous.token);
      restoreEnv('SHEETFLARE_TEST_HOST_ONLY', previous.hostOnly);
    }
  });

  it('applies per-command env overrides on top of the injected env', async () => {
    const result = await withProcessEnv({ CLOUDFLARE_API_TOKEN: 'injected-cloudflare-token' }, () =>
      runCommand(process.execPath, ['-e', childEnvProbe], {
        env: { CLOUDFLARE_API_TOKEN: 'command-cloudflare-token' },
        echoStdout: false,
        echoStderr: false
      })
    );

    expect(JSON.parse(result.stdout).token).toBe('command-cloudflare-token');
  });
});

describe('killProcessTree on Windows', () => {
  it('spawns taskkill.exe directly (there is no taskkill.cmd) and resolves on exit', async () => {
    const { calls, spawnProcess } = createSpawnRecorder('exit');

    await killProcessTree(4321, { platform: 'win32', spawnProcess });

    expect(calls).toEqual([{ command: 'taskkill.exe', args: ['/PID', '4321', '/T', '/F'] }]);
  });

  it('resolves instead of hanging when taskkill cannot be spawned', async () => {
    const { calls, spawnProcess } = createSpawnRecorder('error');

    await killProcessTree(4321, { platform: 'win32', spawnProcess });

    expect(calls).toHaveLength(1);
  });

  it('ignores NaN pids without spawning anything', async () => {
    const { calls, spawnProcess } = createSpawnRecorder('exit');

    await killProcessTree(Number.NaN, { platform: 'win32', spawnProcess });

    expect(calls).toEqual([]);
  });
});
