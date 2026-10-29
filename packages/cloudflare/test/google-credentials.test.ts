import { describe, expect, it } from 'vitest';
import { NotFoundError, ServiceUnavailableError } from '@sheetflare/contracts';
import { defaultGoogleCredentialRef, resolveGoogleCredential, type CloudflareEnv } from '../src';

function createEnv(overrides?: Partial<CloudflareEnv>): CloudflareEnv {
  return {
    CONTROL_PLANE_DO: null as never,
    PROJECT_DO: null as never,
    TABLE_DO: null as never,
    RATE_LIMIT_DO: null as never,
    GOOGLE_CLIENT_EMAIL: 'default@example.com',
    GOOGLE_PRIVATE_KEY: 'default-private-key',
    ...overrides
  };
}

describe('resolveGoogleCredential', () => {
  it('uses the shared gateway credential for the default ref', () => {
    expect(resolveGoogleCredential(createEnv(), defaultGoogleCredentialRef)).toEqual({
      clientEmail: 'default@example.com',
      privateKey: 'default-private-key'
    });
  });

  it('resolves named credentials from GOOGLE_CREDENTIALS_JSON', () => {
    const env = createEnv({
      GOOGLE_CREDENTIALS_JSON: JSON.stringify({
        analytics: {
          clientEmail: 'analytics@example.com',
          privateKey: 'analytics-private-key'
        }
      })
    });

    expect(resolveGoogleCredential(env, 'analytics')).toEqual({
      clientEmail: 'analytics@example.com',
      privateKey: 'analytics-private-key'
    });
  });

  it('resolves named credentials using service-account JSON field names', () => {
    const env = createEnv({
      GOOGLE_CREDENTIALS_JSON: JSON.stringify({
        analytics: {
          client_email: 'analytics@example.com',
          private_key: 'analytics-private-key'
        }
      })
    });

    expect(resolveGoogleCredential(env, 'analytics')).toEqual({
      clientEmail: 'analytics@example.com',
      privateKey: 'analytics-private-key'
    });
  });

  it('fails clearly when a named credential does not exist', () => {
    expect(() => resolveGoogleCredential(createEnv(), 'missing')).toThrowError(NotFoundError);
  });

  it('reports a missing default Google credential as a configuration error', () => {
    const clientEmail = 'default-service-account@example.com';
    const privateKeys = [undefined, '   '] as const;

    for (const privateKey of privateKeys) {
      let caught: unknown;
      try {
        resolveGoogleCredential(
          createEnv({
            GOOGLE_CLIENT_EMAIL: clientEmail,
            GOOGLE_PRIVATE_KEY: privateKey
          }),
          defaultGoogleCredentialRef
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableError);
      if (!(caught instanceof ServiceUnavailableError)) {
        continue;
      }

      expect(caught.status).toBe(503);
      expect(caught.code).toBe('SERVICE_UNAVAILABLE');
      expect(caught.message).not.toContain(clientEmail);
      expect(caught.message).not.toContain('privateKey');
    }
  });
});
