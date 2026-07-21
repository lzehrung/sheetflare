import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildApiSecretCommands,
  collectSetupSecrets,
  hasDefaultGoogleCredentialEnvironment
} from './setup-secrets';

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.GOOGLE_CLIENT_EMAIL;
  delete process.env.GOOGLE_PRIVATE_KEY;
  delete process.env.GOOGLE_DRIVE_WEBHOOK_SECRET;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.ADMIN_BEARER_TOKEN;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('setup secret command builders', () => {
  it('builds worker secret put commands against the provided wrangler config', () => {
    expect(buildApiSecretCommands('apps/api/wrangler.jsonc')).toEqual({
      googlePrivateKey: ['wrangler', 'secret', 'put', 'GOOGLE_PRIVATE_KEY', '--config', 'apps/api/wrangler.jsonc'],
      googleDriveWebhookSecret: ['wrangler', 'secret', 'put', 'GOOGLE_DRIVE_WEBHOOK_SECRET', '--config', 'apps/api/wrangler.jsonc'],
      adminBearerToken: ['wrangler', 'secret', 'put', 'ADMIN_BEARER_TOKEN', '--config', 'apps/api/wrangler.jsonc']
    });
  });


  it('collects secrets noninteractively from environment values', async () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'service-account@example.com';
    process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n';
    process.env.GOOGLE_DRIVE_WEBHOOK_SECRET = 'drive-webhook-secret';
    process.env.ADMIN_BEARER_TOKEN = 'bootstrap-secret';

    expect(await collectSetupSecrets({
      prompter: null
    })).toEqual({
      googleClientEmail: 'service-account@example.com',
      googlePrivateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
      driveWebhookSecret: 'drive-webhook-secret',
      adminBearerToken: 'bootstrap-secret'
    });
  });

  it('collects Google credentials noninteractively from GOOGLE_APPLICATION_CREDENTIALS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-secrets-'));
    tempDirs.push(dir);
    const credentialsPath = join(dir, 'service-account.json');
    await writeFile(credentialsPath, JSON.stringify({
      client_email: 'service-account@example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
    }), 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    const result = await collectSetupSecrets({
      prompter: null
    });

    expect(result.googleClientEmail).toBe('service-account@example.com');
    expect(result.googlePrivateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('detects valid GOOGLE_APPLICATION_CREDENTIALS before offering beginner provisioning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-secrets-'));
    tempDirs.push(dir);
    const credentialsPath = join(dir, 'service-account.json');
    await writeFile(credentialsPath, JSON.stringify({
      client_email: 'service-account@example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
    }), 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    expect(await hasDefaultGoogleCredentialEnvironment()).toBe(true);
  });

  it('does not detect invalid GOOGLE_APPLICATION_CREDENTIALS as usable for beginner setup', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(tmpdir(), 'missing-service-account.json');

    expect(await hasDefaultGoogleCredentialEnvironment()).toBe(false);
  });

  it('does not detect placeholder GOOGLE_APPLICATION_CREDENTIALS as usable for beginner setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-secrets-'));
    tempDirs.push(dir);
    const credentialsPath = join(dir, 'service-account.json');
    await writeFile(credentialsPath, JSON.stringify({
      client_email: 'service-account@your-gcp-project.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
    }), 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

    expect(await hasDefaultGoogleCredentialEnvironment()).toBe(false);
    await expect(collectSetupSecrets({
      prompter: null
    })).rejects.toThrow('must include a real service-account client_email');
  });

  it('does not treat the checked-in placeholder client email as a usable credential', async () => {
    process.env.GOOGLE_CLIENT_EMAIL = 'service-account@your-gcp-project.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n';

    expect(await hasDefaultGoogleCredentialEnvironment()).toBe(false);
  });

  it('fails clearly when noninteractive secret collection lacks Google credentials', async () => {
    await expect(collectSetupSecrets({
      prompter: null
    })).rejects.toThrow(
      'Setup needs Google service-account credentials before it can deploy. Run npm run setup -- --apply-secrets --provision-google to let setup create them with gcloud, set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file, or set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.'
    );
  });

  it('provisions Google credentials noninteractively through gcloud when explicitly requested', async () => {
    process.env.ADMIN_BEARER_TOKEN = 'bootstrap-secret';
    process.env.GOOGLE_DRIVE_WEBHOOK_SECRET = 'drive-webhook-secret';

    const provisionGoogleServiceAccountSpy = vi.fn(async () => ({
      googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
      googlePrivateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
      projectId: 'sheetflare-prod',
      serviceAccountEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
      createdProject: true,
      createdServiceAccount: true
    }));
    const result = await collectSetupSecrets({
      prompter: null,
      googleProvisioning: {
        enabled: true,
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      googleProvisioner: provisionGoogleServiceAccountSpy,
      gcloudAuthChecker: vi.fn(async () => ({
        name: 'gcloud auth',
        status: 'ready',
        summary: 'Google Cloud authentication is available for setup provisioning.',
        remediation: null
      } as const))
    });

    expect(result.googleClientEmail).toBe('sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com');
    expect(result.googlePrivateKey).toContain('BEGIN PRIVATE KEY');
    expect(provisionGoogleServiceAccountSpy).toHaveBeenCalledWith(
      {
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      { debug: false }
    );
  });


  it('respects a prior decision not to offer interactive Google provisioning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheetflare-setup-secrets-'));
    tempDirs.push(dir);
    const credentialsPath = join(dir, 'service-account.json');
    await writeFile(credentialsPath, JSON.stringify({
      client_email: 'service-account@example.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
    }), 'utf8');
    const prompts: string[] = [];

    const result = await collectSetupSecrets({
      prompter: {
        async text(options) {
          prompts.push(options.message);
          return credentialsPath;
        },
        async confirm(options) {
          prompts.push(options.message);
          throw new Error(`Unexpected prompt: ${options.message}`);
        }
      },
      googleProvisioning: {
        enabled: false,
        profile: 'production',
        allowInteractivePrompt: false
      },
      gcloudAuthChecker: vi.fn(async () => {
        throw new Error('gcloud auth should not run when provisioning prompts are disabled.');
      }),
      googleProjectIdResolver: vi.fn(async () => {
        throw new Error('gcloud project lookup should not run when provisioning prompts are disabled.');
      })
    });

    expect(prompts).not.toContain('Provision a Google Cloud project and service account with gcloud now');
    expect(result.googleClientEmail).toBe('service-account@example.com');
  });

});
