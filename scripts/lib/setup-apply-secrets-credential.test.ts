import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSetupConfig } from './setup-config';

const oldBootstrapToken = 'old-bootstrap-token';
const spreadsheetId = '<SPREADSHEET_ID>';

const boundary = vi.hoisted(() => {
  const commands: Array<{ args: string[]; input: string | null; envCredential: string | null }> = [];
  const bearers: string[] = [];
  return { commands, bearers };
});

vi.mock('./process', async () => {
  const actual = await vi.importActual<typeof import('./process')>('./process');
  return {
    ...actual,
    runCommand: vi.fn(async (_command: string, args: string[], options?: {
      input?: string;
      env?: NodeJS.ProcessEnv;
    }) => {
      const envCredential = options?.env?.SHEETFLARE_ADMIN_CREDENTIAL;
      boundary.commands.push({
        args,
        input: options?.input ?? null,
        envCredential: typeof envCredential === 'string' ? envCredential : null
      });
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
  if (url.endsWith('/ready')) {
    return {
      ok: true,
      service: 'sheetflare',
      checks: {
        defaultGoogleCredential: 'configured',
        namedGoogleCredentials: 'missing',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured',
        adminUi: 'enabled'
      },
      notes: []
    };
  }

  if (url.endsWith('/watches/retry-advice')) {
    return { data: [] };
  }

  if (url.endsWith('/watches/register') || url.endsWith('/watches')) {
    return {
      data: url.endsWith('/watches/register')
        ? [{ spreadsheetId, channelId: 'channel-1' }]
        : [activeWatch]
    };
  }

  return {};
}

describe('setup --apply-secrets credential selection', () => {
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

  it('uses the applied bootstrap token for watch registration, smoke, and verify when SHEETFLARE_ADMIN_CREDENTIAL is the superseded token', async () => {
    configDir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-'));
    const configPath = join(configDir, 'sheetflare.setup.json');
    await writeFile(configPath, createDefaultSetupConfig(), 'utf8');

    delete process.env.ADMIN_BEARER_TOKEN;
    delete process.env.GOOGLE_DRIVE_WEBHOOK_SECRET;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_CREDENTIALS_JSON;
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = oldBootstrapToken;
    process.env.SHEETFLARE_BASE_URL = 'https://example.workers.dev';
    process.env.SHEETFLARE_PRIVATE_READ_KEY = 'sfk_read.secret';
    process.env.SHEETFLARE_MUTATION_KEY = 'sfk_mutation.secret';
    process.env.GOOGLE_CLIENT_EMAIL = 'sheetflare@example.com';
    process.env.GOOGLE_PRIVATE_KEY = 'test-private-key';
    process.argv = [process.execPath, 'setup.ts', '--apply-secrets', '--smoke', '--verify', '--config', configPath];
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

    boundary.commands.length = 0;
    boundary.bearers.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      if (authorization?.startsWith('Bearer ')) {
        boundary.bearers.push(authorization.slice('Bearer '.length));
      }
      return Response.json(responseFor(String(input)));
    }));
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`setup exited ${code ?? 0}`);
    });

    const setup = await import('../setup');
    await setup.setupRun;

    const appliedToken = boundary.commands
      .find((command) => command.args.includes('ADMIN_BEARER_TOKEN'))
      ?.input
      ?.trim() ?? null;
    const smokeCredential = boundary.commands.find((command) => command.args.includes('smoke'))?.envCredential ?? null;

    expect(appliedToken).toEqual(expect.any(String));
    expect(appliedToken).not.toBe(oldBootstrapToken);
    expect(boundary.bearers.length).toBeGreaterThan(0);
    expect(boundary.bearers.every((bearer) => bearer === appliedToken)).toBe(true);
    expect(smokeCredential).toBe(appliedToken);
  });
});
