import { afterEach, describe, expect, it } from 'vitest';
import {
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
  it('prefers local setup state over environment fallbacks', () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'env-service-account@example.com';
    process.env.SHEETFLARE_BASE_URL = 'https://env.workers.dev';
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = 'sfk_env.secret';
    process.env.SHEETFLARE_PRIVATE_READ_KEY = 'sfk_env.read';

    expect(resolveSetupRuntimeState({
      googleClientEmail: 'local-service-account@example.com',
      apiUrl: 'https://local.workers.dev',
      adminUiUsername: 'operator@example.com'
    })).toMatchObject({
      googleClientEmail: 'local-service-account@example.com',
      namedGoogleCredentials: 'missing',
      apiUrl: 'https://local.workers.dev',
      adminBearerToken: 'sfk_env.secret',
      adminUiUsername: 'operator@example.com',
      privateReadKey: 'sfk_env.read'
    });
  });

  it('falls back to environment values when local setup state is missing', () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'env-service-account@example.com';
    process.env.SHEETFLARE_BASE_URL = 'https://env.workers.dev';
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = 'sfk_env.secret';
    process.env.SHEETFLARE_PRIVATE_READ_KEY = 'sfk_env.read';
    process.env.SHEETFLARE_MUTATION_KEY = 'sfk_env.mutation';

    expect(resolveSetupRuntimeState(null)).toMatchObject({
      googleClientEmail: 'env-service-account@example.com',
      namedGoogleCredentials: 'missing',
      apiUrl: 'https://env.workers.dev',
      adminBearerToken: 'sfk_env.secret',
      adminApiKey: 'sfk_env.secret',
      privateReadKey: 'sfk_env.read',
      mutationKey: 'sfk_env.mutation'
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

describe('summarizeSetupSecrets', () => {
  it('redacts sensitive values by default', () => {
    expect(summarizeSetupSecrets({
      showSecrets: false,
      localStatePath: 'E:/repo/.sheetflare.setup.local.json',
      adminBearerToken: 'abcdefghijklmno',
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supersecret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supe...cret',
      localStatePath: 'E:/repo/.sheetflare.setup.local.json'
    });
  });

  it('shows full values only when explicitly requested', () => {
    expect(summarizeSetupSecrets({
      showSecrets: true,
      localStatePath: 'E:/repo/.sheetflare.setup.local.json',
      adminBearerToken: 'bearer.secret',
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supersecret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      adminBearerToken: 'bearer.secret',
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supersecret',
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
      adminBearerToken: 'abcdefghijklmno',
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supersecret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).toEqual({
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supe...cret',
      localStatePath: null
    });
  });

  it('does not include runtime api keys in the default terminal summary', () => {
    expect(summarizeSetupSecrets({
      showSecrets: false,
      localStatePath: 'E:/repo/.sheetflare.setup.local.json',
      adminBearerToken: 'bearer.secret',
      adminUiUsername: 'operator@example.com',
      adminUiPassword: 'supersecret',
      adminApiKey: 'sfk_admin.secret',
      privateReadKey: 'sfk_read.secret',
      mutationKey: 'sfk_mutation.secret'
    })).not.toHaveProperty('adminBearerToken');
  });
});
