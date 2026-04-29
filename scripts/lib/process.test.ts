import { describe, expect, it } from 'vitest';
import { runCommand } from './process';

describe('process helpers', () => {
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
});
