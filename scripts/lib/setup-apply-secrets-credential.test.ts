import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSetup } from '../setup';
import type { CommandResult, CommandRunner } from './process';
import { parseSetupArgs } from './setup-cli';
import { createDefaultSetupConfig } from './setup-config';

const oldBootstrapToken = 'old-bootstrap-token';
const spreadsheetId = '<SPREADSHEET_ID>';
const googleEmail = 'sheetflare@example.com';

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

function commandBase(command: string) {
  return command.toLowerCase().replace(/\.cmd$/, '');
}

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
        ? [{ spreadsheetId, channelId: 'channel-1', lastWatchError: null }]
        : [activeWatch]
    };
  }

  return {};
}

describe('setup --apply-secrets credential selection', () => {
  const tempDirs: string[] = [];
  const scopedApiKey = `sfk_11111111-1111-4111-8111-111111111111.${'ab'.repeat(32)}`;

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  async function runSetupWithAdminCredential(adminCredential: string) {
    const configDir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-'));
    tempDirs.push(configDir);
    const configPath = join(configDir, 'sheetflare.setup.json');
    await writeFile(configPath, createDefaultSetupConfig(), 'utf8');

    const commands: Array<{ args: string[]; input: string | null; envCredential: string | null }> = [];
    const bearers: string[] = [];
    const runCommand: CommandRunner = async (command, args, options) => {
      const base = commandBase(command);
      const envCredential = options?.env?.SHEETFLARE_ADMIN_CREDENTIAL;
      commands.push({
        args,
        input: options?.input ?? null,
        envCredential: typeof envCredential === 'string' ? envCredential : null
      });

      if (base === 'npx' && args[0] === 'wrangler' && args[1] === 'whoami') {
        return commandResult(0, 'authenticated\n');
      }
      if (base === 'npx' && args[0] === 'wrangler' && args[1] === 'secret' && args[2] === 'put') {
        return commandResult(0);
      }
      if (base === 'npm' && args[0] === 'run' && args[1] === 'smoke') {
        return commandResult(0, 'smoke ok\n');
      }
      throw new Error(`Unexpected setup command: ${command} ${args.join(' ')}`);
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      if (authorization?.startsWith('Bearer ')) {
        bearers.push(authorization.slice('Bearer '.length));
      }
      return Response.json(responseFor(String(input)));
    };

    await runSetup(parseSetupArgs(['--apply-secrets', '--smoke', '--verify', '--config', configPath]), {
      runCommand,
      fetch: fetchImpl,
      prompter: null,
      env: isolatedEnv({
        SHEETFLARE_ADMIN_CREDENTIAL: adminCredential,
        SHEETFLARE_BASE_URL: 'https://example.workers.dev',
        SHEETFLARE_PRIVATE_READ_KEY: 'sfk_read.secret',
        SHEETFLARE_MUTATION_KEY: 'sfk_mutation.secret',
        GOOGLE_CLIENT_EMAIL: googleEmail,
        GOOGLE_PRIVATE_KEY: 'test-private-key'
      })
    });

    const appliedToken = commands
      .find((command) => command.args.includes('ADMIN_BEARER_TOKEN'))
      ?.input
      ?.trim() ?? null;
    const smokeCredential = commands.find((command) => command.args.includes('smoke'))?.envCredential ?? null;

    return { appliedToken, smokeCredential, bearers };
  }

  it('uses the applied bootstrap token for watch registration, smoke, and verify when SHEETFLARE_ADMIN_CREDENTIAL is the superseded token', async () => {
    const { appliedToken, smokeCredential, bearers } = await runSetupWithAdminCredential(oldBootstrapToken);

    expect(appliedToken).toEqual(expect.any(String));
    expect(appliedToken).not.toBe(oldBootstrapToken);
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.every((bearer) => bearer === appliedToken)).toBe(true);
    expect(smokeCredential).toBe(appliedToken);
  });

  it('keeps the operator-selected API key for watch registration, smoke, and verify when SHEETFLARE_ADMIN_CREDENTIAL is an API key', async () => {
    const { appliedToken, smokeCredential, bearers } = await runSetupWithAdminCredential(scopedApiKey);

    expect(appliedToken).toEqual(expect.any(String));
    expect(appliedToken).not.toBe(scopedApiKey);
    expect(bearers.length).toBeGreaterThan(0);
    expect(bearers.every((bearer) => bearer === scopedApiKey)).toBe(true);
    expect(smokeCredential).toBe(scopedApiKey);
  });
});
