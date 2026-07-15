import { describe, expect, it, vi } from 'vitest';
import {
  checkSetupPrereqsWithOptions,
  checkWranglerAuthPrereq,
  recordPrereqResult,
  resolveModuleSpecifier
} from './setup-prereqs';
import { actionsRequireWranglerAuth } from './setup-cli';

describe('checkSetupPrereqs', () => {
  it.each([
    {
      name: 'verify only',
      actions: {
        applySecretsNow: false,
        deployNow: false,
        bootstrapNow: false,
        smokeNow: false,
        verifyNow: true
      },
      expectedNames: ['Repo install']
    },
    {
      name: 'apply secrets',
      actions: {
        applySecretsNow: true,
        deployNow: false,
        bootstrapNow: false,
        smokeNow: false,
        verifyNow: false
      },
      expectedNames: ['Repo install', 'Wrangler auth']
    },
    {
      name: 'deploy Worker',
      actions: {
        applySecretsNow: false,
        deployNow: true,
        bootstrapNow: false,
        smokeNow: false,
        verifyNow: false
      },
      expectedNames: ['Repo install', 'Wrangler auth']
    }
  ])('$name checks only its required tools', async ({ actions, expectedNames }) => {
    const results = await checkSetupPrereqsWithOptions(
      { includeWranglerAuth: actionsRequireWranglerAuth(actions) },
      {
        commandRunner: vi.fn(async () => ({
          code: 0,
          stdout: 'you@example.com',
          stderr: ''
        })),
        pathExists: vi.fn(async () => true),
        moduleResolver: vi.fn(() => undefined)
      }
    );

    expect(results.map((result) => result.name)).toEqual(expectedNames);
  });

  it('blocks when workspace dependencies are missing', async () => {
    const results = await checkSetupPrereqsWithOptions(
      { includeWranglerAuth: false },
      {
        pathExists: vi.fn(async () => false),
        moduleResolver: vi.fn(() => {
          throw new Error('missing');
        })
      }
    );

    expect(results[0]).toEqual({
      name: 'Repo install',
      status: 'blocked',
      summary: 'Workspace dependencies are not installed.',
      remediation: 'Run npm install from the repository root before setup.'
    });
  });

  it('checks gcloud auth on demand for Google provisioning flows', async () => {
    const commandRunner = vi.fn(async () => ({
      code: 0,
      stdout: 'you@example.com\n',
      stderr: ''
    }));

    const results = await checkSetupPrereqsWithOptions(
      { includeWranglerAuth: false, includeGcloudAuth: true },
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
      },
      {
        name: 'gcloud auth',
        status: 'ready',
        summary: 'Google Cloud authentication is available for setup provisioning.',
        remediation: null
      }
    ]);
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

  it('records lazy prereq checks for later verification', () => {
    const results = [{
      name: 'Repo install',
      status: 'ready' as const,
      summary: 'Workspace dependencies are available.',
      remediation: null
    }];
    const wranglerResult = {
      name: 'Wrangler auth',
      status: 'ready' as const,
      summary: 'Wrangler authentication is available for deploy steps.',
      remediation: null
    };

    recordPrereqResult(results, wranglerResult);

    expect(results).toContain(wranglerResult);
  });

  it('updates existing prereq results by name instead of appending duplicates', () => {
    const results = [{
      name: 'Wrangler auth',
      status: 'blocked' as const,
      summary: 'Wrangler is not authenticated on this machine.',
      remediation: 'Run npx wrangler login before applying secrets or deploying.'
    }];
    const readyResult = {
      name: 'Wrangler auth',
      status: 'ready' as const,
      summary: 'Wrangler authentication is available for deploy steps.',
      remediation: null
    };

    recordPrereqResult(results, readyResult);

    expect(results).toEqual([readyResult]);
  });

  it('resolves workspace modules without relying on a CommonJS require global', () => {
    const originalRequire = Reflect.get(globalThis, 'require');
    Reflect.set(globalThis, 'require', undefined);
    try {
      const resolvedPath = resolveModuleSpecifier('@sheetflare/contracts');
      expect(resolvedPath).toContain('packages');
      expect(resolvedPath).toContain('contracts');
    } finally {
      if (originalRequire === undefined) {
        Reflect.deleteProperty(globalThis, 'require');
      } else {
        Reflect.set(globalThis, 'require', originalRequire);
      }
    }
  });
});
