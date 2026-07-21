import { describe, expect, it } from 'vitest';
import {
  createDefaultSetupConfig,
  getSetupConfigGoogleCredentialRefs,
  normalizeSpreadsheetId,
  parseSetupConfig,
  setupConfigUsesDefaultGoogleCredential,
  type SetupProfile
} from './setup-config';

describe('parseSetupConfig', () => {
  it.each([
    { input: ' PrOdUcTiOn ', expected: 'production' },
    { input: ' StAgInG ', expected: 'staging' }
  ] satisfies ReadonlyArray<{ input: string; expected: SetupProfile }>)('parses $input as the supported $expected profile', ({ input, expected }) => {
    const inputConfig: Record<string, unknown> = JSON.parse(createDefaultSetupConfig(expected));
    inputConfig.profile = input;

    const profile: SetupProfile = parseSetupConfig(inputConfig).profile;

    expect(profile).toBe(expected);
  });

  it('parses the legacy generated local setup config as canonical production without retaining deploy settings', () => {
    const legacyGeneratedDefaultConfig = {
      profile: ' LoCaL ',
      deploy: {
        api: true,
        admin: true
      },
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: '<SPREADSHEET_ID>',
        googleCredentialRef: 'default',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users',
            idColumn: '_id',
            indexedFields: ['name', 'status'],
            cacheTtlSeconds: 60
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke Row',
          status: 'active'
        },
        updateValues: {
          status: 'inactive'
        }
      }
    };

    const parsed = parseSetupConfig(legacyGeneratedDefaultConfig);
    expect(parsed.profile).toBe('production');
    expect(parsed).not.toHaveProperty('deploy');
  });

  it.each(['production-like', 'stage', 'localhost'])('rejects the unsupported %s profile instead of selecting a deployment fallback', (profile) => {
    const inputConfig: Record<string, unknown> = JSON.parse(createDefaultSetupConfig('production'));
    inputConfig.profile = profile;

    expect(() => parseSetupConfig(inputConfig)).toThrow('profile must be production or staging.');
  });

  it('parses a legacy private-only setup config and removes deploy settings', () => {
    const config = parseSetupConfig({
      profile: 'production',
      deploy: {
        api: true,
        admin: false
      },
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users',
            indexedFields: ['email']
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    });

    expect(config).toMatchObject({
      profile: 'production',
      privateProject: {
        slug: 'demo'
      },
      publicReadProject: null,
      smoke: {
        privateTableSlug: 'users',
        publicTableSlug: null
      }
    });
    expect(config).not.toHaveProperty('deploy');
  });

  it('rejects project-level defaultAuthMode in setup config', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        defaultAuthMode: 'private',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toThrow('privateProject.defaultAuthMode is not supported in sheetflare.setup.json.');
  });

  it('parses a setup config with optional public-read coverage', () => {
    expect(parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo-private',
        name: 'Demo Private',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: {
        slug: 'demo-public',
        name: 'Demo Public',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: 'users',
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toMatchObject({
      publicReadProject: {
        slug: 'demo-public'
      },
      smoke: {
        publicTableSlug: 'users'
      }
    });
  });

  it('rejects duplicate smoke key names', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'same',
        privateReadKeyName: 'same',
        mutationKeyName: 'other',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toThrow('smoke adminKeyName, privateReadKeyName, and mutationKeyName must be distinct.');
  });

  it('rejects a private smoke target that does not exist', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'missing',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toThrow('smoke.privateTableSlug must reference a configured table slug in demo.');
  });

  it('requires a public smoke table when public-read project is configured', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo-private',
        name: 'Demo Private',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: {
        slug: 'demo-public',
        name: 'Demo Public',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toThrow('smoke.publicTableSlug must be set when publicReadProject is configured.');
  });

  it('rejects smoke writes to the managed id column', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users',
            idColumn: '_id'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          _id: 'smoke-id'
        },
        updateValues: {
          name: 'Smoke'
        }
      }
    })).toThrow('smoke.createValues must not write the managed ID column _id.');
  });

  it('rejects smoke writes to read-only fields', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users',
            readOnlyFields: ['derived']
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          derived: 'should-fail'
        }
      }
    })).toThrow('smoke.updateValues must not write read-only field derived.');
  });

  it('rejects smoke values outside the real row contract', () => {
    expect(() => parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          metadata: {
            nested: true
          }
        },
        updateValues: {
          status: 'active'
        }
      }
    })).toThrow('smoke.createValues is invalid: metadata');
  });
});

describe('setup credential refs', () => {
  it('detects default and named Google credential refs from configured projects', () => {
    const config = parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo-private',
        name: 'Demo Private',
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'prod',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: {
        slug: 'demo-public',
        name: 'Demo Public',
        spreadsheetId: 'sheet-1',
        tables: [
          {
            tableSlug: 'public-users',
            sheetTabName: 'Users'
          }
        ]
      },
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: 'public-users',
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    });

    expect([...getSetupConfigGoogleCredentialRefs(config)].sort()).toEqual(['default', 'prod']);
    expect(setupConfigUsesDefaultGoogleCredential(config)).toBe(true);
  });

  it('detects named-only Google credential configs', () => {
    const config = parseSetupConfig({
      profile: 'production',
      privateProject: {
        slug: 'demo',
        name: 'Demo',
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'prod',
        tables: [
          {
            tableSlug: 'users',
            sheetTabName: 'Users'
          }
        ]
      },
      publicReadProject: null,
      smoke: {
        enabled: true,
        privateTableSlug: 'users',
        publicTableSlug: null,
        adminKeyName: 'demo-admin',
        privateReadKeyName: 'demo-read',
        mutationKeyName: 'demo-mutation',
        createValues: {
          name: 'Smoke'
        },
        updateValues: {
          status: 'active'
        }
      }
    });

    expect([...getSetupConfigGoogleCredentialRefs(config)]).toEqual(['prod']);
    expect(setupConfigUsesDefaultGoogleCredential(config)).toBe(false);
  });
});

describe('spreadsheet id normalization', () => {
  it('extracts a spreadsheet id from a docs.google.com URL', () => {
    expect(
      normalizeSpreadsheetId('https://docs.google.com/spreadsheets/d/1k7FSqq9PmtAB0jp9b9oT0gJHMMKNcgU23pgWIo4sRjo/edit?usp=sharing')
    ).toBe('1k7FSqq9PmtAB0jp9b9oT0gJHMMKNcgU23pgWIo4sRjo');
  });

  it('accepts a bare spreadsheet id', () => {
    expect(normalizeSpreadsheetId('sheet-1')).toBe('sheet-1');
  });

  it('rejects unsupported URLs', () => {
    expect(() => normalizeSpreadsheetId('https://example.com/not-a-sheet')).toThrow(
      'Spreadsheet URL must look like https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/...'
    );
  });
});

describe('setup config serialization', () => {
  it('emits a starter config without the removed deploy block', () => {
    const parsed: unknown = JSON.parse(createDefaultSetupConfig());

    expect(parsed).not.toHaveProperty('deploy');
    expect(parseSetupConfig(parsed)).toMatchObject({
      profile: 'production',
      privateProject: {
        slug: 'demo'
      }
    });
  });

  it('round-trips an explicit staging starter config without a deploy block', () => {
    const serialized = createDefaultSetupConfig('staging');
    const parsed: unknown = JSON.parse(serialized);

    expect(parsed).not.toHaveProperty('deploy');
    expect(parseSetupConfig(parsed)).toMatchObject({
      profile: 'staging',
      privateProject: {
        slug: 'demo'
      }
    });
  });

});
