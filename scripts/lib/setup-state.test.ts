import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSetupLocalState,
  createSetupLocalStateFromUnknown,
  getSetupLocalStatePath,
  readSetupLocalState,
  redactSetupLocalState,
  writeSetupLocalState
} from './setup-state';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('setup local state', () => {
  it('writes and reads local state beside the config path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-state-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'sheetflare.setup.json');

    await writeSetupLocalState(configPath, {
      apiUrl: 'https://example.workers.dev',
      adminApiKey: 'sfk_admin.secret'
    });

    expect(await readSetupLocalState(configPath)).toEqual({
      apiUrl: 'https://example.workers.dev',
      adminApiKey: 'sfk_admin.secret'
    });
    expect(getSetupLocalStatePath(configPath)).toBe(join(dir, '.sheetflare.setup.local.json'));
  });

  it('redacts secret values for terminal summaries', () => {
    expect(redactSetupLocalState({
      googleClientEmail: 'service-account@example.iam.gserviceaccount.com',
      adminBearerToken: 'abcdefghijklmno',
      adminApiKey: 'sfk_admin.secret'
    })).toEqual({
      googleClientEmail: 'service-account@example.iam.gserviceaccount.com',
      apiUrl: null,
      adminUrl: null,
      adminBearerToken: 'abcd...lmno',
      adminUiUsername: null,
      adminUiPassword: null,
      adminApiKey: 'sfk_...cret',
      privateReadKey: null,
      mutationKey: null
    });
  });

  it('omits undefined and blank values when building local state updates', () => {
    expect(createSetupLocalState({
      apiUrl: 'https://example.workers.dev',
      adminUrl: '',
      adminBearerToken: undefined,
      adminUiUsername: 'operator@example.com'
    })).toEqual({
      apiUrl: 'https://example.workers.dev',
      adminUiUsername: 'operator@example.com'
    });
  });

  it('rejects invalid persisted local state on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-state-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'sheetflare.setup.json');
    await writeFile(getSetupLocalStatePath(configPath), `${JSON.stringify({ apiUrl: 42 }, null, 2)}\n`, 'utf8');

    await expect(readSetupLocalState(configPath)).rejects.toThrow('apiUrl must be a string.');
  });

  it('rejects non-string local state values from disk', () => {
    expect(() => createSetupLocalStateFromUnknown({
      apiUrl: 42
    }, 'state.json')).toThrow('state.json.apiUrl must be a string.');
  });

  it('rejects unknown local state keys from disk', () => {
    expect(() => createSetupLocalStateFromUnknown({
      unexpected: 'value'
    }, 'state.json')).toThrow('state.json contains unknown key unexpected.');
  });
});
