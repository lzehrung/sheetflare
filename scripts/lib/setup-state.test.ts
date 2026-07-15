import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSetupLocalState,
  createSetupLocalStateFromUnknown,
  getSetupLocalStatePath,
  mergeSetupLocalState,
  readSetupLocalState,
  writeSetupLocalState
} from './setup-state';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('setup local state', () => {
  it('writes and reads Worker-only local state beside the config path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-state-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'sheetflare.setup.json');

    await writeSetupLocalState(configPath, {
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://example.workers.dev'
    });

    expect(await readSetupLocalState(configPath)).toEqual({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://example.workers.dev'
    });
    expect(getSetupLocalStatePath(configPath)).toBe(join(dir, '.sheetflare.setup.local.json'));
  });

  it('removes null update keys when merging local state updates', () => {
    expect(mergeSetupLocalState({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://old.example.workers.dev'
    }, createSetupLocalState({
      googleClientEmail: null,
      apiUrl: 'https://new.example.workers.dev'
    }))).toEqual({
      apiUrl: 'https://new.example.workers.dev'
    });
  });


  it('omits blank values when building local state updates', () => {
    expect(createSetupLocalState({
      googleClientEmail: '',
      apiUrl: 'https://example.workers.dev'
    })).toEqual({
      apiUrl: 'https://example.workers.dev'
    });
  });

  it('preserves null markers when building local state updates', () => {
    expect(createSetupLocalState({
      googleClientEmail: null,
      apiUrl: 'https://example.workers.dev'
    })).toEqual({
      googleClientEmail: null,
      apiUrl: 'https://example.workers.dev'
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

  it('tombstones exactly the three removed local-admin keys', () => {
    expect(createSetupLocalStateFromUnknown({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://example.workers.dev',
      adminUrl: 'https://legacy-admin.example',
      adminUiUsername: 'operator',
      adminUiPassword: 'secret'
    }, 'state.json')).toEqual({
      googleClientEmail: 'service-account@example.com',
      apiUrl: 'https://example.workers.dev'
    });
  });


  it('rejects a removed live credential that is not one of the three tombstones', () => {
    expect(() => createSetupLocalStateFromUnknown({
      adminBearerToken: 'bootstrap.secret'
    }, 'state.json')).toThrow('state.json contains unknown key adminBearerToken.');
  });
});
