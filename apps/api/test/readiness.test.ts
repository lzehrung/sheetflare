import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { __resetGatewayStateForTests, createApp } from '../src/index';
import { apiKeys, forgedApiKey } from './support/api-keys';
import { createEnv, probesOf } from './support/harness';

const fullReadinessSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  checks: z.object({
    controlPlane: z.literal('ok'),
    rateLimit: z.literal('ok'),
    defaultGoogleCredential: z.string(),
    namedGoogleCredentials: z.string(),
    googleDriveWebhookSecret: z.string(),
    bootstrapAdmin: z.string(),
    adminUi: z.string()
  }),
  notes: z.array(z.string())
});

const placeholderGoogleEmail = 'service-account@your-gcp-project.iam.gserviceaccount.com';

function readyAs(authorization: string | undefined, env = createEnv()) {
  const headers = authorization === undefined ? {} : { authorization };
  return createApp().request('/ready', { headers }, env);
}

beforeEach(() => {
  __resetGatewayStateForTests();
});

describe('readiness for anonymous callers', () => {
  it('reports only whether the service is ready', async () => {
    const response = await readyAs(undefined);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'sheetflare-api' });
  });

  it('keeps the 503 status but still hides configuration state when nothing is ready', async () => {
    const response = await readyAs(undefined, createEnv({ googleClientEmail: placeholderGoogleEmail }));

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, service: 'sheetflare-api' });
    for (const configurationState of ['bootstrapAdmin', 'googleDriveWebhookSecret', 'namedGoogleCredentials', 'GOOGLE_']) {
      expect(text).not.toContain(configurationState);
    }
  });

  it('treats an unusable credential as a failed sign-in instead of quietly downgrading it', async () => {
    const response = await readyAs(forgedApiKey.authorization);

    expect(response.status).toBe(401);
  });
});

describe('readiness details', () => {
  it.each([
    { name: 'the bootstrap admin token', authorization: 'Bearer secret' },
    { name: 'a global key with admin:projects', authorization: apiKeys.globalAdmin.authorization }
  ])('are shown to $name', async ({ authorization }) => {
    const response = await readyAs(authorization);

    expect(response.status).toBe(200);
    const body = fullReadinessSchema.parse(await response.json());
    expect(body.ok).toBe(true);
    expect(body.checks.bootstrapAdmin).toBe('configured');
    expect(body.notes.length).toBeGreaterThan(0);
  });

  it('notes when the bootstrap token or the Drive webhook secret is shorter than 32 characters', async () => {
    const shortToken = 'short-admin-token';
    const shortWebhookSecret = 'short-webhook-secret';
    const response = await readyAs('Bearer short-admin-token', createEnv({
      adminBearerToken: shortToken,
      googleDriveWebhookSecret: shortWebhookSecret
    }));

    expect(response.status).toBe(200);
    const body = fullReadinessSchema.parse(await response.json());
    const text = JSON.stringify(body);
    expect(body.notes).toEqual(expect.arrayContaining([
      'ADMIN_BEARER_TOKEN is shorter than 32 characters.',
      'GOOGLE_DRIVE_WEBHOOK_SECRET is shorter than 32 characters.'
    ]));
    expect(text).not.toContain(shortToken);
    expect(text).not.toContain(shortWebhookSecret);
    expect(text).not.toContain(String(shortToken.length));
    expect(text).not.toContain(String(shortWebhookSecret.length));
  });

  it('stays quiet about secrets that are at least 32 characters', async () => {
    const response = await readyAs(`Bearer ${'a'.repeat(32)}`, createEnv({
      adminBearerToken: 'a'.repeat(32),
      googleDriveWebhookSecret: 'b'.repeat(32)
    }));

    const body = fullReadinessSchema.parse(await response.json());
    expect(body.notes.join('\n')).not.toContain('shorter than 32 characters');
  });

  it.each([
    { name: 'a project-scoped admin key', authorization: apiKeys.projectAdmin.authorization },
    { name: 'a global key without admin:projects', authorization: apiKeys.global.authorization }
  ])('are refused to $name with 403', async ({ authorization }) => {
    const response = await readyAs(authorization);

    expect(response.status).toBe(403);
  });
});

describe('readiness cost', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-26T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 300 anonymous probes with one control plane call and no unique-key rate limit rows', async () => {
    const env = createEnv();

    for (let probe = 0; probe < 300; probe += 1) {
      expect((await readyAs(undefined, env)).status).toBe(200);
    }

    const probes = probesOf(env);
    expect(probes.controlPlaneRequests.length).toBeLessThanOrEqual(1);
    expect(probes.controlPlaneRequests.map((request) => request.type)).not.toContain('control.projects.list');
    // One shared key per window, not a fresh key (and therefore a fresh stored row) for every request.
    expect(new Set(probes.rateLimitRequests.map((request) => request.key))).toEqual(new Set(['system.ready']));
  });

  it('is limited per client like the rest of the API and does not reach the control plane when limited', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      vi.setSystemTime(new Date('2026-04-26T00:00:30.000Z'));
      const env = createEnv({ rateLimitAllowed: false });

      const response = await readyAs(undefined, env);

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('30');
      expect(probesOf(env).controlPlaneRequests).toEqual([]);
      expect(probesOf(env).rateLimitRequests).toEqual([{ name: 'rate-limit:system:client:anonymous', key: 'system.ready' }]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('probes the control plane again after ten seconds', async () => {
    const env = createEnv();

    await readyAs(undefined, env);
    vi.setSystemTime(new Date('2026-04-26T00:00:09.900Z'));
    await readyAs(undefined, env);
    expect(probesOf(env).controlPlaneRequests).toHaveLength(1);

    vi.setSystemTime(new Date('2026-04-26T00:00:10.100Z'));
    await readyAs(undefined, env);
    expect(probesOf(env).controlPlaneRequests).toHaveLength(2);
  });

  it('reports an unreachable control plane without hammering it, and recovers on the next window', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      let controlPlaneDown = true;
      const env = createEnv({
        hooks: {
          controlPlane: () => {
            if (controlPlaneDown) {
              throw new Error('connect ECONNRESET');
            }
            return undefined;
          }
        }
      });

      expect((await readyAs(undefined, env)).status).toBe(500);
      expect((await readyAs(undefined, env)).status).toBe(500);
      expect(probesOf(env).controlPlaneRequests).toHaveLength(1);

      controlPlaneDown = false;
      vi.setSystemTime(new Date('2026-04-26T00:00:10.100Z'));
      expect((await readyAs(undefined, env)).status).toBe(200);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
