import { describe, expect, it, vi } from 'vitest';
import { checkSetupPrereqs, checkSetupPrereqsWithOptions, checkWranglerAuthPrereq } from './setup-prereqs';

describe('checkSetupPrereqs', () => {
  it('reports ready results when install and wrangler auth are available', async () => {
    const results = await checkSetupPrereqs({
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: 'you@example.com',
        stderr: ''
      })),
      pathExists: vi.fn(async () => true),
      moduleResolver: vi.fn(() => undefined)
    });

    expect(results).toEqual([
      {
        name: 'Repo install',
        status: 'ready',
        summary: 'Workspace dependencies are available.',
        remediation: null
      },
      {
        name: 'Wrangler auth',
        status: 'ready',
        summary: 'Wrangler authentication is available for deploy steps.',
        remediation: null
      }
    ]);
  });

  it('blocks when workspace dependencies are missing', async () => {
    const results = await checkSetupPrereqs({
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: '',
        stderr: ''
      })),
      pathExists: vi.fn(async () => false),
      moduleResolver: vi.fn(() => {
        throw new Error('missing');
      })
    });

    expect(results[0]).toEqual({
      name: 'Repo install',
      status: 'blocked',
      summary: 'Workspace dependencies are not installed.',
      remediation: 'Run npm install from the repository root before setup.'
    });
  });

  it('blocks wrangler deploy steps when whoami fails', async () => {
    const results = await checkSetupPrereqs({
      commandRunner: vi.fn(async () => ({
        code: 1,
        stdout: '',
        stderr: 'not authenticated'
      })),
      pathExists: vi.fn(async () => true),
      moduleResolver: vi.fn(() => undefined)
    });

    expect(results[1]).toEqual({
      name: 'Wrangler auth',
      status: 'blocked',
      summary: 'Wrangler is not authenticated on this machine.',
      remediation: 'Run npx wrangler login before applying secrets or deploying.'
    });
  });

  it('can skip wrangler auth when the requested setup actions do not need it', async () => {
    const commandRunner = vi.fn(async () => ({
      code: 0,
      stdout: 'you@example.com',
      stderr: ''
    }));

    const results = await checkSetupPrereqsWithOptions(
      { includeWranglerAuth: false },
      {
        commandRunner,
        pathExists: vi.fn(async () => true),
        moduleResolver: vi.fn(() => undefined)
      }
    );

    expect(results).toEqual([
      {
        name: 'Repo install',
        status: 'ready',
        summary: 'Workspace dependencies are available.',
        remediation: null
      }
    ]);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('checks wrangler auth on demand', async () => {
    const result = await checkWranglerAuthPrereq({
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: 'you@example.com',
        stderr: ''
      }))
    });

    expect(result).toEqual({
      name: 'Wrangler auth',
      status: 'ready',
      summary: 'Wrangler authentication is available for deploy steps.',
      remediation: null
    });
  });
});
