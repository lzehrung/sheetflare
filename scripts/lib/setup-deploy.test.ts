import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildApiDeployCommand,
  getApiWranglerConfigPath,
  patchApiConfigForDeploy,
  withPatchedJsonConfig
} from './setup-deploy';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('setup deploy command builders', () => {
  it('builds the pinned API deploy command', () => {
    expect(buildApiDeployCommand('wrangler.setup.jsonc')).toEqual([
      'wrangler@4.85.0',
      'deploy',
      '--config',
      'wrangler.setup.jsonc'
    ]);
  });

  it('uses the correct API wrangler config path for each profile', () => {
    expect(getApiWranglerConfigPath('production').replace(/\\/g, '/')).toContain('apps/api/wrangler.jsonc');
    expect(getApiWranglerConfigPath('staging').replace(/\\/g, '/')).toContain('apps/api/wrangler.staging.jsonc');
  });

  it('writes a temporary patched config and removes it after success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-deploy-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'wrangler.jsonc');
    await writeFile(configPath, `${JSON.stringify({ name: 'sheetflare-api', vars: {} }, null, 2)}\n`, 'utf8');

    let tempConfigPath = '';
    const result = await withPatchedJsonConfig(
      configPath,
      (config) => ({
        ...config,
        vars: {
          ...(typeof config.vars === 'object' && config.vars !== null ? config.vars : {}),
          GOOGLE_CLIENT_EMAIL: 'service-account@example.com'
        }
      }),
      async (path) => {
        tempConfigPath = path;
        const text = await readFile(path, 'utf8');
        return JSON.parse(text) as { vars: { GOOGLE_CLIENT_EMAIL: string } };
      }
    );

    expect(result.vars.GOOGLE_CLIENT_EMAIL).toBe('service-account@example.com');
    await expect(readFile(configPath, 'utf8')).resolves.toContain('"sheetflare-api"');
    await expect(readFile(tempConfigPath, 'utf8')).rejects.toThrow();
  });

  it('accepts commented JSONC wrangler configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-deploy-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'wrangler.jsonc');
    await writeFile(
      configPath,
      `{
  // starter comment
  "name": "sheetflare-api",
  "vars": {
    "RATE_LIMIT_MAX_REQUESTS": "300",
  },
}
`,
      'utf8'
    );

    const result = await withPatchedJsonConfig(
      configPath,
      (config) => ({
        ...config,
        vars: {
          ...(typeof config.vars === 'object' && config.vars !== null ? config.vars : {}),
          GOOGLE_CLIENT_EMAIL: 'service-account@example.com'
        }
      }),
      async (path) => JSON.parse(await readFile(path, 'utf8')) as { vars: { GOOGLE_CLIENT_EMAIL: string; RATE_LIMIT_MAX_REQUESTS: string } }
    );

    expect(result.vars.GOOGLE_CLIENT_EMAIL).toBe('service-account@example.com');
    expect(result.vars.RATE_LIMIT_MAX_REQUESTS).toBe('300');
  });

  it('patches or removes GOOGLE_CLIENT_EMAIL for API deploys', () => {
    expect(patchApiConfigForDeploy({
      name: 'sheetflare-api',
      vars: {
        RATE_LIMIT_MAX_REQUESTS: '300'
      }
    }, 'service-account@example.com')).toMatchObject({
      vars: {
        GOOGLE_CLIENT_EMAIL: 'service-account@example.com',
        RATE_LIMIT_MAX_REQUESTS: '300'
      }
    });

    const namedOnlyConfig = patchApiConfigForDeploy({
      name: 'sheetflare-api',
      vars: {
        GOOGLE_CLIENT_EMAIL: 'stale-default@example.com',
        RATE_LIMIT_MAX_REQUESTS: '300'
      }
    }, null);

    expect(namedOnlyConfig.vars).toMatchObject({
      RATE_LIMIT_MAX_REQUESTS: '300'
    });
    expect((namedOnlyConfig.vars as Record<string, unknown>).GOOGLE_CLIENT_EMAIL).toBeUndefined();
  });

  it('removes the temporary patched config after failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-deploy-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'wrangler.jsonc');
    await writeFile(configPath, `${JSON.stringify({ name: 'sheetflare-api' }, null, 2)}\n`, 'utf8');

    let tempConfigPath = '';
    await expect(withPatchedJsonConfig(
      configPath,
      (config) => ({ ...config, name: 'patched-name' }),
      async (path) => {
        tempConfigPath = path;
        throw new Error('boom');
      }
    )).rejects.toThrow('boom');

    await expect(readFile(configPath, 'utf8')).resolves.toContain('"sheetflare-api"');
    await expect(readFile(tempConfigPath, 'utf8')).rejects.toThrow();
  });

  it('rejects invalid JSONC config content with a clear error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-deploy-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'wrangler.jsonc');
    await writeFile(configPath, '{ "name": "sheetflare-api", ', 'utf8');

    await expect(withPatchedJsonConfig(
      configPath,
      (config) => config,
      async () => null
    )).rejects.toThrow('must contain valid JSONC for setup orchestration');
  });
});
