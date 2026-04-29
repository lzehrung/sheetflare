import { describe, expect, it } from 'vitest';
import {
  createDefaultSetupConfig,
  normalizeSpreadsheetId,
  parseSetupConfig,
  serializeSetupConfig
} from './setup-config';

describe('parseSetupConfig', () => {
  it('parses a private-only setup config', () => {
    expect(parseSetupConfig({
      profile: 'local',
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
    })).toMatchObject({
      profile: 'local',
      deploy: {
        api: true,
        admin: false
      },
      privateProject: {
        slug: 'demo'
      },
      publicReadProject: null,
      smoke: {
        privateTableSlug: 'users',
        publicTableSlug: null
      }
    });
  });

  it('parses a setup config with optional public-read coverage', () => {
    expect(parseSetupConfig({
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
      profile: 'local',
      deploy: {
        api: true,
        admin: true
      },
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
  it('round-trips the starter config', () => {
    const serialized = createDefaultSetupConfig();
    expect(parseSetupConfig(JSON.parse(serialized))).toMatchObject({
      profile: 'local',
      privateProject: {
        slug: 'demo'
      }
    });
  });

  it('serializes with a trailing newline', () => {
    const serialized = serializeSetupConfig(parseSetupConfig(JSON.parse(createDefaultSetupConfig())));
    expect(serialized.endsWith('\n')).toBe(true);
  });
});
