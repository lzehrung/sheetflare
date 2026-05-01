import { describe, expect, it, vi } from 'vitest';
import { getAdminPagesVerificationUrls, verifyAdminPagesDeployment } from './setup-verify';

describe('getAdminPagesVerificationUrls', () => {
  it('returns the canonical verification urls without duplicating slashes', () => {
    expect(getAdminPagesVerificationUrls('https://sheetflare-admin.pages.dev/')).toEqual([
      'https://sheetflare-admin.pages.dev',
      'https://sheetflare-admin.pages.dev/ready',
      'https://sheetflare-admin.pages.dev/docs',
      'https://sheetflare-admin.pages.dev/v1/admin/projects'
    ]);
  });
});

describe('verifyAdminPagesDeployment', () => {
  it('succeeds when the admin root and proxied routes are all healthy', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response('<title>Sheetflare API Docs</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('{"error":{"code":"UNAUTHORIZED"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }));

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
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://sheetflare-admin.pages.dev/ready', expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, 'https://sheetflare-admin.pages.dev/docs', expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(4, 'https://sheetflare-admin.pages.dev/v1/admin/projects', expect.any(Object));
  });

  it('retries when a proxied route is not healthy yet and eventually succeeds', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('oops', {
        status: 530,
        headers: { 'content-type': 'text/plain' }
      }))
      .mockResolvedValueOnce(new Response('<title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response('<title>Sheetflare API Docs</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('{"error":{"code":"UNAUTHORIZED"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      }));
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

  it('fails clearly when a proxied route never becomes healthy', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('error', {
        status: 530,
        headers: { 'content-type': 'text/plain' }
      }));

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 1
    }, {
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow(
      'Admin Pages verification failed for https://sheetflare-admin.pages.dev/ready with status 530.'
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

  it('fails clearly when a proxied admin route returns HTML instead of JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
      .mockResolvedValueOnce(new Response('<title>Sheetflare API Docs</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
      .mockResolvedValueOnce(new Response('<!doctype html><title>Sheetflare Admin</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }));

    await expect(verifyAdminPagesDeployment({
      password: 'secret',
      siteUrl: 'https://sheetflare-admin.pages.dev',
      username: 'admin',
      maxAttempts: 1
    }, {
      fetchImpl,
      sleep: async () => {}
    })).rejects.toThrow(
      'Admin Pages verification failed for https://sheetflare-admin.pages.dev/v1/admin/projects with status 200.'
    );
  });
});
