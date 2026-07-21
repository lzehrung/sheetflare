import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeSetupRuntimeState,
  resolvePreferredAdminCredential,
  resolveSetupRuntimeState,
  summarizeSetupSecrets
} from './setup-runtime';

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_EMAIL;
  delete process.env.GOOGLE_CREDENTIALS_JSON;
  delete process.env.SHEETFLARE_BASE_URL;
  delete process.env.SHEETFLARE_ADMIN_CREDENTIAL;
  delete process.env.SHEETFLARE_PRIVATE_READ_KEY;
  delete process.env.SHEETFLARE_MUTATION_KEY;
});

describe('resolveSetupRuntimeState', () => {
  it('prefers local setup state over environment values', () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'env-service-account@example.com';
    process.env.SHEETFLARE_BASE_URL = 'https://env.workers.dev';
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = 'sfk_env.secret';
    process.env.SHEETFLARE_PRIVATE_READ_KEY = 'sfk_env.read';

    expect(resolveSetupRuntimeState({
      googleClientEmail: 'local-service-account@example.com',
      apiUrl: 'https://local.workers.dev'
    })).toMatchObject({
      googleClientEmail: 'local-service-account@example.com',
      namedGoogleCredentials: 'missing',
      apiUrl: 'https://local.workers.dev',
      adminBearerToken: 'sfk_env.secret',
      privateReadKey: 'sfk_env.read'
    });
  });


  it('reports named Google credentials when GOOGLE_CREDENTIALS_JSON is valid', () => {
    process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({
      prod: {
        client_email: 'service@example.com',
        private_key: 'secret'
      }
    });

    expect(resolveSetupRuntimeState(null)).toMatchObject({
      namedGoogleCredentials: 'configured'
    });
  });
});

describe('resolvePreferredAdminCredential', () => {
  it('prefers a scoped admin api key when available', () => {
    expect(resolvePreferredAdminCredential({
      adminApiKey: 'sfk_admin.secret',
      adminBearerToken: 'bootstrap.secret'
    })).toBe('sfk_admin.secret');
  });

  it('falls back to the bootstrap admin credential when no admin api key exists', () => {
    expect(resolvePreferredAdminCredential({
      adminApiKey: null,
      adminBearerToken: 'bootstrap.secret'
    })).toBe('bootstrap.secret');
  });
});

describe('mergeSetupRuntimeState', () => {
  it('merges fresh Worker credentials into resolved runtime state', () => {
    const base = resolveSetupRuntimeState({
      googleClientEmail: 'persisted@example.com',
      apiUrl: 'https://persisted.workers.dev'
    });

    expect(mergeSetupRuntimeState(base, {
      googleClientEmail: 'fresh@example.com',
      apiUrl: 'https://fresh.workers.dev',
      adminBearerToken: 'bootstrap.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toMatchObject({
      googleClientEmail: 'fresh@example.com',
      apiUrl: 'https://fresh.workers.dev',
      adminBearerToken: 'bootstrap.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    });
  });
});

describe('summarizeSetupSecrets', () => {
  it('omits every credential when secret display is disabled', () => {
    expect(summarizeSetupSecrets({
      showSecrets: false,
      localStatePath: 'E:/repo/.sheetflare.setup.local.json',
      adminBearerToken: 'bearer.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      localStatePath: 'E:/repo/.sheetflare.setup.local.json'
    });
  });

  it('shows full values only when explicitly requested', () => {
    expect(summarizeSetupSecrets({
      showSecrets: true,
      localStatePath: 'E:/repo/.sheetflare.setup.local.json',
      adminBearerToken: 'bearer.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      adminBearerToken: 'bearer.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret',
      localStatePath: 'E:/repo/.sheetflare.setup.local.json'
    });
  });

  it('reports no local state path when the current run did not persist local state', () => {
    expect(summarizeSetupSecrets({
      showSecrets: false,
      localStatePath: null,
      adminBearerToken: 'bearer.secret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      localStatePath: null
    });
  });
});
