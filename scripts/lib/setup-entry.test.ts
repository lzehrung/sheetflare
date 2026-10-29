import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adminCreateApiKeyInputSchema,
  adminCreateApiKeyResultSchema,
  adminListApiKeysResultSchema,
  type AdminCreateApiKeyResult
} from '@sheetflare/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpsBootstrap } from '../bootstrap-run';
import { runSetup } from '../setup';
import type { CommandResult, CommandRunner } from './process';
import { getProcessEnv, withProcessEnv } from './runtime';
import { parseSetupArgs } from './setup-cli';
import { createDefaultSetupConfig, parseSetupConfig, serializeSetupConfig, type SetupConfig } from './setup-config';
import type { SetupPrompter } from './setup-prompts';
import { getSetupLocalStatePath, writeSetupLocalState } from './setup-state';

const googleEmail = 'sheetflare-setup@example.iam.gserviceaccount.com';
const privateKey = 'BEGIN-SHEETFLARE-TEST-PRIVATE-KEY';
const spreadsheetId = 'spreadsheet-main';
const handoffHeading = 'SAVE THESE CREDENTIALS NOW';
const watchRecoveryCommand = 'npm run ops:watch:drive';
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
  'SHEETFLARE_MUTATION_KEY',
  'SHEETFLARE_SHOW_SECRETS',
  'SHEETFLARE_BOOTSTRAP_ROTATE_KEYS',
  'SHEETFLARE_BOOTSTRAP_RESULT_MODE',
  'SHEETFLARE_BOOTSTRAP_CONFIG_JSON'
];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandBase(command: string) {
  return command.toLowerCase().replace(/\.cmd$/, '');
}

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

function secretText(input: string | undefined) {
  if (!input) {
    return '';
  }
  return input.endsWith('\n') ? input.slice(0, -1) : input;
}

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) {
      return count;
    }
    count += 1;
    from = index + needle.length;
  }
  return count;
}

function scriptedPrompter(answers: Record<string, string>): SetupPrompter {
  return {
    text(options) {
      const answer = Object.prototype.hasOwnProperty.call(answers, options.message)
        ? answers[options.message]
        : options.defaultValue;
      if (answer === undefined) {
        return Promise.reject(new Error(`Unexpected setup prompt: ${options.message}`));
      }
      const validationError = options.validate?.(answer) ?? null;
      if (validationError) {
        return Promise.reject(new Error(`${options.message}: ${validationError}`));
      }
      return Promise.resolve(answer);
    },
    confirm(options) {
      return Promise.resolve(options.defaultValue);
    }
  };
}

function headerValue(headers: HeadersInit | undefined, name: string) {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name);
    return match?.[1] ?? null;
  }
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name);
  if (!key) {
    return null;
  }
  return headers[key] ?? null;
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function createWorker() {
  const keys: AdminCreateApiKeyResult[] = [];
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const watches: Array<{ spreadsheetId: string; channelId: string }> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    requests.push({
      method,
      path,
      authorization: headerValue(init?.headers, 'authorization')
    });

    if (method === 'POST' && path === '/v1/admin/projects') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (!isRecord(body) || typeof body.slug !== 'string') {
        return jsonResponse(400, { error: 'project slug missing' });
      }
      return jsonResponse(201, { project: { slug: body.slug } });
    }

    const tableMatch = /^\/v1\/admin\/projects\/([^/]+)\/tables$/.exec(path);
    if (method === 'POST' && tableMatch?.[1]) {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (!isRecord(body) || typeof body.tableSlug !== 'string') {
        return jsonResponse(400, { error: 'table slug missing' });
      }
      return jsonResponse(201, {
        data: {
          projectSlug: decodeURIComponent(tableMatch[1]),
          tableSlug: body.tableSlug
        }
      });
    }

    if (path === '/v1/admin/keys' && method === 'GET') {
      return jsonResponse(200, adminListApiKeysResultSchema.parse({
        data: keys.filter((key) => key.record.revokedAt === null).map((key) => key.record)
      }));
    }

    if (path === '/v1/admin/keys' && method === 'POST') {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      const parsed = adminCreateApiKeyInputSchema.parse(body);
      const created = adminCreateApiKeyResultSchema.parse({
        apiKey: `sf-test-${parsed.name}`,
        record: {
          id: `key-${keys.length + 1}`,
          projectSlug: parsed.projectSlug ?? null,
          name: parsed.name,
          scopes: parsed.scopes,
          createdAt: '2026-10-29T00:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null
        }
      });
      keys.push(created);
      return jsonResponse(201, created);
    }

    const revokeMatch = /^\/v1\/admin\/keys\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && revokeMatch?.[1]) {
      const id = decodeURIComponent(revokeMatch[1]);
      const index = keys.findIndex((key) => key.record.id === id);
      const existing = keys[index];
      if (!existing) {
        return jsonResponse(404, { error: 'missing key' });
      }
      keys[index] = adminCreateApiKeyResultSchema.parse({
        ...existing,
        record: { ...existing.record, revokedAt: '2026-10-29T01:00:00.000Z' }
      });
      return jsonResponse(200, { ok: true });
    }

    if (method === 'POST' && path === '/v1/admin/system/google/drive/watches/register') {
      watches.splice(0, watches.length, { spreadsheetId, channelId: 'channel-1' });
      return jsonResponse(200, { data: watches });
    }

    if (method === 'GET' && path === '/v1/admin/system/google/drive/watches/retry-advice') {
      return jsonResponse(200, { data: [] });
    }

    if (method === 'GET' && path === '/v1/admin/system/google/drive/watches') {
      return jsonResponse(200, { data: watches });
    }

    if (method === 'GET' && path === '/ready') {
      return jsonResponse(200, {
        ok: true,
        service: 'sheetflare',
        checks: {
          defaultGoogleCredential: 'configured',
          namedGoogleCredentials: 'configured',
          googleDriveWebhookSecret: 'configured',
          bootstrapAdmin: 'configured',
          adminUi: 'enabled'
        }
      });
    }

    return jsonResponse(404, { error: `unexpected ${method} ${path}` });
  };

  return { fetchImpl, keys, requests, watches };
}

function createHarness(options: { failSmoke?: boolean; deployUrl?: string } = {}) {
  const commands: Array<{ command: string; args: string[] }> = [];
  const secrets = new Map<string, string>();
  const deployConfigs: unknown[] = [];
  const worker = createWorker();
  const deployUrl = options.deployUrl ?? 'https://sheetflare-test.workers.dev';

  const runCommand: CommandRunner = async (command, args, commandOptions) => {
    commands.push({ command, args: [...args] });
    const base = commandBase(command);

    if (base === 'npx' && args[0] === 'wrangler' && args[1] === 'whoami') {
      return commandResult(0, 'authenticated\n');
    }

    if (base === 'npx' && args[0] === 'wrangler' && args[1] === 'secret' && args[2] === 'put') {
      const name = args[3];
      if (!name) {
        throw new Error('wrangler secret put is missing a name');
      }
      secrets.set(name, secretText(commandOptions?.input));
      return commandResult(0);
    }

    if (base === 'npm' && args[0] === '--workspace' && args[1] === '@sheetflare/admin' && args[2] === 'run' && args[3] === 'build') {
      return commandResult(0);
    }

    if (base === 'npx' && args[0] === 'wrangler@4.107.0' && args[1] === 'deploy') {
      const configIndex = args.indexOf('--config');
      const configPath = args[configIndex + 1];
      if (!configPath) {
        throw new Error('wrangler deploy is missing --config');
      }
      const text = await readFile(configPath, 'utf8');
      deployConfigs.push(JSON.parse(text));
      return commandResult(0, `Deployed ${deployUrl}\n`);
    }

    if (base === 'npm' && args[0] === 'run' && args[1] === 'ops:bootstrap') {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const previousLog = console.log;
      const previousError = console.error;
      console.log = (...items: unknown[]) => {
        stdout.push(items.map((item) => String(item)).join(' '));
      };
      console.error = (...items: unknown[]) => {
        stderr.push(items.map((item) => String(item)).join(' '));
      };
      try {
        await withProcessEnv({ ...getProcessEnv(), ...commandOptions?.env }, () => runOpsBootstrap());
        return commandResult(0, stdout.join('\n'), stderr.join('\n'));
      } catch (error) {
        stderr.push(error instanceof Error ? error.message : String(error));
        return commandResult(1, stdout.join('\n'), stderr.join('\n'));
      } finally {
        console.log = previousLog;
        console.error = previousError;
      }
    }

    if (base === 'npm' && args[0] === 'run' && args[1] === 'smoke') {
      if (options.failSmoke) {
        return commandResult(1, '', '');
      }
      return commandResult(0, 'smoke ok\n');
    }

    throw new Error(`Unexpected setup command: ${command} ${args.join(' ')}`);
  };

  return { runCommand, worker, commands, secrets, deployConfigs };
}

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-entry-'));
  tempDirs.push(dir);
  return dir;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

async function writeConfig(dir: string, adminUi: SetupConfig['adminUi']) {
  const config: SetupConfig = {
    ...parseSetupConfig(parseJson(createDefaultSetupConfig())),
    adminUi
  };
  const configPath = join(dir, 'sheetflare.setup.json');
  await writeFile(configPath, serializeSetupConfig(config), 'utf8');
  return configPath;
}

async function withCapturedConsole<T>(fn: () => Promise<T>) {
  const logs: string[] = [];
  const warns: string[] = [];
  const previousLog = console.log;
  const previousWarn = console.warn;
  console.log = (...items: unknown[]) => {
    logs.push(items.map((item) => String(item)).join(' '));
  };
  console.warn = (...items: unknown[]) => {
    warns.push(items.map((item) => String(item)).join(' '));
  };
  try {
    return { result: await fn(), logs, warns };
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
  }
}

function mintedSecrets(secrets: Map<string, string>, keys: readonly AdminCreateApiKeyResult[]) {
  return [
    privateKey,
    secrets.get('ADMIN_BEARER_TOKEN') ?? '',
    secrets.get('GOOGLE_DRIVE_WEBHOOK_SECRET') ?? '',
    ...keys.map((key) => key.apiKey)
  ].filter((secret) => secret.length > 0);
}

async function expectLocalStateOmitsSecrets(configPath: string, secrets: readonly string[]) {
  const text = await readFile(getSetupLocalStatePath(configPath), 'utf8');
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
  const parsed = parseJson(text);
  if (!isRecord(parsed)) {
    throw new Error('setup local state is not a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    expect(['apiUrl', 'googleClientEmail']).toContain(key);
  }
  const configText = await readFile(configPath, 'utf8');
  for (const secret of secrets) {
    expect(configText).not.toContain(secret);
  }
  return parsed;
}

function registerRequests(worker: ReturnType<typeof createWorker>) {
  return worker.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/watches/register'));
}

describe('setup entry point', () => {
  it('prints a fresh setup handoff once when a later step fails and keeps secrets out of local state', async () => {
    const dir = await createTempDir();
    const harness = createHarness({ failSmoke: true });
    const env = isolatedEnv({
      GOOGLE_CLIENT_EMAIL: googleEmail,
      GOOGLE_PRIVATE_KEY: privateKey
    });

    let failure: unknown;
    const captured = await withCapturedConsole(async () => {
      try {
        await runSetup(parseSetupArgs([]), {
          runCommand: harness.runCommand,
          fetch: harness.worker.fetchImpl,
          prompter: scriptedPrompter({
            'Google Sheet URL or spreadsheet ID': spreadsheetId,
            'Existing Google Sheets tab name': 'Sheet1',
            'Writable sheet column to use for setup validation': 'status'
          }),
          paths: { cwd: dir },
          env
        });
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toContain('Smoke validation failed');
    const output = captured.logs.join('\n');
    const token = harness.secrets.get('ADMIN_BEARER_TOKEN') ?? '';
    const webhookSecret = harness.secrets.get('GOOGLE_DRIVE_WEBHOOK_SECRET') ?? '';
    expect(token.length).toBeGreaterThan(0);
    expect(webhookSecret.length).toBeGreaterThan(0);
    expect(countOccurrences(output, handoffHeading)).toBe(1);
    expect(countOccurrences(output, token)).toBe(1);
    expect(output).not.toContain(webhookSecret);
    expect(output).not.toContain(privateKey);
    expect(harness.worker.keys).toHaveLength(3);
    for (const key of harness.worker.keys) {
      expect(countOccurrences(output, key.apiKey)).toBe(1);
    }

    const configPath = join(dir, 'sheetflare.setup.json');
    const state = await expectLocalStateOmitsSecrets(configPath, mintedSecrets(harness.secrets, harness.worker.keys));
    expect(state.googleClientEmail).toBe(googleEmail);
    expect(state.apiUrl).toBe('https://sheetflare-test.workers.dev');
    expect(harness.commands.some((entry) => entry.args.includes('@sheetflare/admin'))).toBe(true);
    const deployConfig = harness.deployConfigs[0];
    expect(isRecord(deployConfig) && isRecord(deployConfig.vars) && deployConfig.vars.ADMIN_UI).toBe('enabled');
    expect(isRecord(deployConfig) && deployConfig.assets).toBeTruthy();
    expect(registerRequests(harness.worker)).toHaveLength(1);
  });

  it('re-registers Drive watches when apply-secrets knows the API URL and admin credential', async () => {
    const dir = await createTempDir();
    const configPath = await writeConfig(dir, 'enabled');
    await writeSetupLocalState(configPath, {
      apiUrl: 'https://known-api.workers.dev',
      googleClientEmail: googleEmail
    });
    const harness = createHarness();
    const adminCredential = 'known-admin-credential';

    await withCapturedConsole(() => runSetup(parseSetupArgs(['--config', configPath, '--apply-secrets']), {
      runCommand: harness.runCommand,
      fetch: harness.worker.fetchImpl,
      prompter: null,
      env: isolatedEnv({
        GOOGLE_CLIENT_EMAIL: googleEmail,
        GOOGLE_PRIVATE_KEY: privateKey,
        SHEETFLARE_ADMIN_CREDENTIAL: adminCredential
      })
    }));

    const registrations = registerRequests(harness.worker);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.authorization).toBe(`Bearer ${adminCredential}`);
    await expectLocalStateOmitsSecrets(configPath, mintedSecrets(harness.secrets, harness.worker.keys));
  });

  it('warns with the watch recovery command when apply-secrets lacks the API URL and admin credential', async () => {
    const dir = await createTempDir();
    const configPath = await writeConfig(dir, 'enabled');
    const harness = createHarness();

    const captured = await withCapturedConsole(() => runSetup(parseSetupArgs(['--config', configPath, '--apply-secrets']), {
      runCommand: harness.runCommand,
      fetch: harness.worker.fetchImpl,
      prompter: null,
      env: isolatedEnv({
        GOOGLE_CLIENT_EMAIL: googleEmail,
        GOOGLE_PRIVATE_KEY: privateKey
      })
    }));

    expect(registerRequests(harness.worker)).toHaveLength(0);
    expect(captured.warns.join('\n')).toContain(watchRecoveryCommand);
    expect(captured.warns.join('\n')).toContain('SHEETFLARE_BASE_URL');
    await expectLocalStateOmitsSecrets(configPath, mintedSecrets(harness.secrets, harness.worker.keys));
  });

  it('skips existing managed keys when bootstrap is rerun', async () => {
    const dir = await createTempDir();
    const configPath = await writeConfig(dir, 'enabled');
    const harness = createHarness();
    const env = isolatedEnv({
      SHEETFLARE_BASE_URL: 'https://bootstrap-api.workers.dev',
      SHEETFLARE_ADMIN_CREDENTIAL: 'bootstrap-admin-token'
    });
    const deps = {
      runCommand: harness.runCommand,
      fetch: harness.worker.fetchImpl,
      prompter: null,
      env
    };

    const first = await withCapturedConsole(() => runSetup(parseSetupArgs(['--config', configPath, '--bootstrap']), deps));
    expect(harness.worker.keys.map((key) => key.record.name)).toEqual(['demo-admin', 'demo-read', 'demo-mutation']);
    expect(countOccurrences(first.logs.join('\n'), handoffHeading)).toBe(1);
    for (const key of harness.worker.keys) {
      expect(first.logs.join('\n')).toContain(key.apiKey);
    }

    const second = await withCapturedConsole(() => runSetup(parseSetupArgs(['--config', configPath, '--bootstrap']), deps));
    expect(harness.worker.keys).toHaveLength(3);
    expect(second.warns.join('\n')).toContain('Left existing API keys in place: demo-admin, demo-read, demo-mutation');
    expect(second.logs.join('\n')).not.toContain(handoffHeading);
    for (const key of harness.worker.keys) {
      expect(second.logs.join('\n')).not.toContain(key.apiKey);
    }
    await expectLocalStateOmitsSecrets(configPath, harness.worker.keys.map((key) => key.apiKey));
  });

  it('deploys with the admin build and assets omitted when adminUi is disabled', async () => {
    const dir = await createTempDir();
    const configPath = await writeConfig(dir, 'disabled');
    const harness = createHarness({ deployUrl: 'https://sheetflare-disabled.workers.dev' });

    await withCapturedConsole(() => runSetup(parseSetupArgs(['--config', configPath, '--deploy']), {
      runCommand: harness.runCommand,
      fetch: harness.worker.fetchImpl,
      prompter: null,
      env: isolatedEnv({ GOOGLE_CLIENT_EMAIL: googleEmail })
    }));

    expect(harness.commands.some((entry) => entry.args.includes('@sheetflare/admin'))).toBe(false);
    const deployConfig = harness.deployConfigs[0];
    expect(isRecord(deployConfig)).toBe(true);
    if (!isRecord(deployConfig)) {
      return;
    }
    expect(deployConfig.assets).toBeUndefined();
    expect(isRecord(deployConfig.vars) && deployConfig.vars.ADMIN_UI).toBe('disabled');
    expect(deployConfig.vars && isRecord(deployConfig.vars) ? deployConfig.vars.GOOGLE_CLIENT_EMAIL : null).toBe(googleEmail);
  });
});
