import { describe, expect, it, vi } from 'vitest';
import { getAdminPagesVerificationUrls, verifyAdminPagesDeployment } from './setup-verify';

describe('getAdminPagesVerificationUrls', () => {
  it('returns the canonical root and docs urls without duplicating slashes', () => {
    expect(getAdminPagesVerificationUrls('https://sheetflare-admin.pages.dev/')).toEqual([
      'https://sheetflare-admin.pages.dev',
      'https://sheetflare-admin.pages.dev/docs'
    ]);
  });
});

describe('verifyAdminPagesDeployment', () => {
  it('succeeds when the root and docs routes are both healthy', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('docs', { status: 200 }));

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 1
    }, {
      fetchImpl,
      sleep: async () => {}
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://sheetflare-admin.pages.dev', expect.objectContaining({
      headers: expect.objectContaining({
        authorization: expect.stringMatching(/^Basic /)
      }),
      redirect: 'manual'
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://sheetflare-admin.pages.dev/docs', expect.any(Object));
  });

  it('retries when docs is not healthy yet and eventually succeeds', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('error', { status: 530 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('docs', { status: 200 }));
    const sleep = vi.fn(async () => {});

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 2,
      retryDelayMs: 1
    }, {
      fetchImpl,
      sleep
    })).resolves.toBeUndefined();

    expect(sleep).toHaveBeenCalledOnce();
  });

  it('fails clearly when docs never becomes healthy', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('error', { status: 530 }));

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 1
    }, {
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow(
      'Admin Pages verification failed for https://sheetflare-admin.pages.dev/docs with status 530.'
    );
  });

  it('fails clearly when the site cannot be reached at all', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValue(new Error('connect failed'));

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 1
    }, {
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow(
      'Admin Pages verification failed for https://sheetflare-admin.pages.dev. The request could not reach the deployed site.'
    );
  });
});
