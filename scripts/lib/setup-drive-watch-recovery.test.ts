import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSetup } from '../setup';
import type { CommandResult, CommandRunner } from './process';
import { parseSetupArgs } from './setup-cli';
import { createDefaultSetupConfig } from './setup-config';

const oldBootstrapToken = 'old-bootstrap-token';
const spreadsheetId = '<SPREADSHEET_ID>';
const bootstrapSuccessStdout = '__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[],"skippedKeys":[],"revokedKeys":[]}\n';

const clearedEnv = [
  'ADMIN_BEARER_TOKEN',
  'GOOGLE_DRIVE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CREDENTIALS_JSON',
  'SHEETFLARE_BASE_URL',
  'SHEETFLARE_ADMIN_CREDENTIAL',
  'SHEETFLARE_ADMIN_BEARER',
  'SHEETFLARE_PRIVATE_READ_KEY',
  'SHEETFLARE_MUTATION_KEY'
];

const boundary: {
  commands: Array<{ args: string[]; input: string | null }>;
  bearers: string[];
  fetchUrls: string[];
} = {
  commands: [],
  bearers: [],
  fetchUrls: []
};

const activeWatch = {
  spreadsheetId,
  googleCredentialRef: 'default',
  channelId: 'channel-1',
  resourceId: 'resource-1',
  resourceUri: null,
  expirationAt: '2099-05-01T00:00:00.000Z',
  lastWatchError: null,
  lastNotificationAt: null,
  pendingChangedAt: null,
  debounceUntil: null,
  lastReindexStartedAt: null,
  lastReindexCompletedAt: null,
  lastReindexError: null,
  projectSlugs: ['demo']
};

function isolatedEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!clearedEnv.includes(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

function commandResult(code: number, stdout = '', stderr = ''): CommandResult {
  return { code, signal: null, stdout, stderr };
}

function responseFor(url: string) {
  if (url.endsWith('/watches/register') || url.endsWith('/watches')) {
    return {
      data: url.endsWith('/watches/register')
        ? [{ spreadsheetId, channelId: 'channel-1' }]
        : [activeWatch]
    };
  }

  return {};
}

function rememberBearer(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const authorization = headers.get('authorization');
  if (authorization?.startsWith('Bearer ')) {
    boundary.bearers.push(authorization.slice('Bearer '.length));
  }
}

function appliedAdminToken() {
  return boundary.commands
    .find((command) => command.args.includes('ADMIN_BEARER_TOKEN'))
    ?.input
    ?.trim() ?? null;
}

function registerUrls() {
  return boundary.fetchUrls.filter((url) => url.endsWith('/watches/register'));
}

describe('setup Drive watch recovery after webhook secret replacement', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  async function runSetupWithDeps(options: {
    args: string[];
    baseUrl?: string | null;
    bootstrap?: { code: number; stdout: string; stderr: string };
    fetch?: typeof fetch;
  }) {
    const configDir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-'));
    tempDirs.push(configDir);
    const configPath = join(configDir, 'sheetflare.setup.json');
    await writeFile(configPath, createDefaultSetupConfig(), 'utf8');

    boundary.commands.length = 0;
    boundary.bearers.length = 0;
    boundary.fetchUrls.length = 0;
    const bootstrap = {
      code: options.bootstrap?.code ?? 0,
      stdout: options.bootstrap?.stdout ?? bootstrapSuccessStdout,
      stderr: options.bootstrap?.stderr ?? ''
    };

    const overrides: Record<string, string> = {
      SHEETFLARE_ADMIN_CREDENTIAL: oldBootstrapToken,
      GOOGLE_CLIENT_EMAIL: 'sheetflare@example.com',
      GOOGLE_PRIVATE_KEY: 'test-private-key'
    };
    if (options.baseUrl) {
      overrides.SHEETFLARE_BASE_URL = options.baseUrl;
    }

    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('runSetup must not call process.exit');
    });

    const runCommand: CommandRunner = async (_command, args, commandOptions) => {
      boundary.commands.push({ args, input: commandOptions?.input ?? null });
      if (args.includes('ops:bootstrap')) {
        return commandResult(bootstrap.code, bootstrap.stdout, bootstrap.stderr);
      }
      return commandResult(0);
    };
    const fetchImpl: typeof fetch = options.fetch ?? (async (input, init) => {
      rememberBearer(init);
      boundary.fetchUrls.push(String(input));
      return Response.json(responseFor(String(input)));
    });

    const cliOptions = parseSetupArgs([...options.args, '--config', configPath]);
    const env = isolatedEnv(overrides);
    return {
      run: () => runSetup(cliOptions, { runCommand, fetch: fetchImpl, prompter: null, env }),
      warnings,
      exitSpy
    };
  }

  it('re-registers Drive watches with the applied credential when bootstrap throws after --apply-secrets', async () => {
    const { run } = await runSetupWithDeps({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev',
      bootstrap: { code: 1, stdout: '', stderr: 'bootstrap failed' }
    });

    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);

    const appliedToken = appliedAdminToken();
    expect(appliedToken).toEqual(expect.any(String));
    expect(appliedToken).not.toBe(oldBootstrapToken);
    expect(registerUrls()).toHaveLength(1);
    expect(boundary.bearers.length).toBeGreaterThan(0);
    expect(boundary.bearers.every((bearer) => bearer === appliedToken)).toBe(true);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('Bootstrap failed');
  });

  it('registers Drive watches once when --apply-secrets and bootstrap succeed', async () => {
    const { run, exitSpy } = await runSetupWithDeps({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev'
    });

    await expect(run()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(registerUrls()).toHaveLength(1);
    const appliedToken = appliedAdminToken();
    expect(boundary.bearers.every((bearer) => bearer === appliedToken)).toBe(true);
  });

  it('warns with the recovery command when the API URL is unknown after the webhook secret is replaced', async () => {
    const { run, warnings } = await runSetupWithDeps({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: null
    });

    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(registerUrls()).toHaveLength(0);
    expect(warnings.join('\n')).toContain('npm run ops:watch:drive');
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('SHEETFLARE_BASE_URL');
  });

  it('warns with the recovery command when re-registration fails and still reports the bootstrap error', async () => {
    const { run, warnings } = await runSetupWithDeps({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev',
      bootstrap: { code: 1, stdout: '', stderr: 'bootstrap failed' },
      fetch: async (input, init) => {
        rememberBearer(init);
        boundary.fetchUrls.push(String(input));
        if (String(input).endsWith('/watches/register')) {
          throw new Error('register failed');
        }
        return Response.json(responseFor(String(input)));
      }
    });

    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(registerUrls()).toHaveLength(1);
    const appliedToken = appliedAdminToken();
    expect(boundary.bearers).toEqual([appliedToken]);
    expect(warnings.join('\n')).toContain('npm run ops:watch:drive');
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('Bootstrap failed');
    expect(message).not.toContain('register failed');
  });
});
