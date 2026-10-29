import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSetupConfig } from './setup-config';

const oldBootstrapToken = 'old-bootstrap-token';
const spreadsheetId = '<SPREADSHEET_ID>';
const bootstrapSuccessStdout = '__SHEETFLARE_BOOTSTRAP_RESULT__={"projects":[],"apiKeys":[],"skippedKeys":[],"revokedKeys":[]}\n';

const boundary = vi.hoisted(() => {
  const commands: Array<{ args: string[]; input: string | null }> = [];
  const bearers: string[] = [];
  const fetchUrls: string[] = [];
  const bootstrap = {
    code: 0,
    stdout: '',
    stderr: ''
  };
  return { commands, bearers, fetchUrls, bootstrap };
});

vi.mock('./process', async () => {
  const actual = await vi.importActual<typeof import('./process')>('./process');
  return {
    ...actual,
    runCommand: vi.fn(async (_command: string, args: string[], options?: { input?: string }) => {
      boundary.commands.push({
        args,
        input: options?.input ?? null
      });
      if (args.includes('ops:bootstrap')) {
        return {
          code: boundary.bootstrap.code,
          stdout: boundary.bootstrap.stdout,
          stderr: boundary.bootstrap.stderr
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    })
  };
});

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
  const previousArgv = process.argv.slice();
  const previousEnv = { ...process.env };
  const previousStdinIsTTY = process.stdin.isTTY;
  const previousStdoutIsTTY = process.stdout.isTTY;
  let configDir: string | null = null;

  afterEach(async () => {
    process.argv = previousArgv;
    for (const key of Object.keys(process.env)) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: previousStdinIsTTY });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: previousStdoutIsTTY });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (configDir) {
      await rm(configDir, { recursive: true, force: true });
      configDir = null;
    }
  });

  async function runSetup(options: {
    args: string[];
    baseUrl?: string | null;
    bootstrap?: { code: number; stdout: string; stderr: string };
    fetch?: typeof fetch;
  }) {
    configDir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-'));
    const configPath = join(configDir, 'sheetflare.setup.json');
    await writeFile(configPath, createDefaultSetupConfig(), 'utf8');

    delete process.env.ADMIN_BEARER_TOKEN;
    delete process.env.GOOGLE_DRIVE_WEBHOOK_SECRET;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_CREDENTIALS_JSON;
    delete process.env.SHEETFLARE_BASE_URL;
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = oldBootstrapToken;
    process.env.GOOGLE_CLIENT_EMAIL = 'sheetflare@example.com';
    process.env.GOOGLE_PRIVATE_KEY = 'test-private-key';
    if (options.baseUrl) {
      process.env.SHEETFLARE_BASE_URL = options.baseUrl;
    }

    process.argv = [process.execPath, 'setup.ts', ...options.args, '--config', configPath];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    boundary.commands.length = 0;
    boundary.bearers.length = 0;
    boundary.fetchUrls.length = 0;
    boundary.bootstrap.code = options.bootstrap?.code ?? 0;
    boundary.bootstrap.stdout = options.bootstrap?.stdout ?? bootstrapSuccessStdout;
    boundary.bootstrap.stderr = options.bootstrap?.stderr ?? '';

    const warnings: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`setup exited ${code ?? 0}`);
    });

    vi.stubGlobal('fetch', options.fetch ?? vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      rememberBearer(init);
      boundary.fetchUrls.push(String(input));
      return Response.json(responseFor(String(input)));
    }));

    vi.resetModules();
    const setup = await import('../setup');
    return { setup, warnings, errors, exitSpy };
  }

  it('re-registers Drive watches with the applied credential when bootstrap throws after --apply-secrets', async () => {
    const { setup, errors } = await runSetup({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev',
      bootstrap: { code: 1, stdout: '', stderr: 'bootstrap failed' }
    });

    await expect(setup.setupRun).rejects.toThrow('setup exited 1');

    const appliedToken = appliedAdminToken();
    expect(appliedToken).toEqual(expect.any(String));
    expect(appliedToken).not.toBe(oldBootstrapToken);
    expect(registerUrls()).toHaveLength(1);
    expect(boundary.bearers.length).toBeGreaterThan(0);
    expect(boundary.bearers.every((bearer) => bearer === appliedToken)).toBe(true);
    expect(errors.join('\n')).toContain('Bootstrap failed');
  });

  it('registers Drive watches once when --apply-secrets and bootstrap succeed', async () => {
    const { setup, exitSpy } = await runSetup({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev'
    });

    await expect(setup.setupRun).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(registerUrls()).toHaveLength(1);
    const appliedToken = appliedAdminToken();
    expect(boundary.bearers.every((bearer) => bearer === appliedToken)).toBe(true);
  });

  it('warns with the recovery command when the API URL is unknown after the webhook secret is replaced', async () => {
    const { setup, warnings, errors } = await runSetup({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: null
    });

    await expect(setup.setupRun).rejects.toThrow('setup exited 1');
    expect(registerUrls()).toHaveLength(0);
    expect(warnings.join('\n')).toContain('npm run ops:watch:drive');
    expect(errors.join('\n')).toContain('SHEETFLARE_BASE_URL');
  });

  it('warns with the recovery command when re-registration fails and still reports the bootstrap error', async () => {
    const { setup, warnings, errors } = await runSetup({
      args: ['--apply-secrets', '--bootstrap'],
      baseUrl: 'https://example.workers.dev',
      bootstrap: { code: 1, stdout: '', stderr: 'bootstrap failed' },
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        rememberBearer(init);
        boundary.fetchUrls.push(String(input));
        if (String(input).endsWith('/watches/register')) {
          throw new Error('register failed');
        }
        return Response.json(responseFor(String(input)));
      })
    });

    await expect(setup.setupRun).rejects.toThrow('setup exited 1');
    expect(registerUrls()).toHaveLength(1);
    const appliedToken = appliedAdminToken();
    expect(boundary.bearers).toEqual([appliedToken]);
    expect(warnings.join('\n')).toContain('npm run ops:watch:drive');
    expect(errors.join('\n')).toContain('Bootstrap failed');
    expect(errors.join('\n')).not.toContain('register failed');
  });
});
