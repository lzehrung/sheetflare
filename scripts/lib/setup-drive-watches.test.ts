import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDriveWatches } from './setup-drive-watches';

describe('registerDriveWatches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers Drive watches through the admin api with explicit overrides when provided', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          {
            spreadsheetId: 'sheet-1',
            channelId: 'channel-sheet-1'
          }
        ]
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'sfk_admin.secret',
      debounceSeconds: 45,
      expirationHours: 72
    })).resolves.toEqual([
      {
        spreadsheetId: 'sheet-1',
        channelId: 'channel-sheet-1'
      }
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sfk_admin.secret',
          'content-type': 'application/json'
        }),
        body: JSON.stringify({
          debounceSeconds: 45,
          expirationHours: 72
        })
      })
    );
  });

  it('omits override fields when setup uses defaults', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await registerDriveWatches({
      baseUrl: 'https://example.workers.dev',
      adminCredential: 'bootstrap.secret'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.workers.dev/v1/admin/system/google/drive/watches/register',
      expect.objectContaining({
        body: JSON.stringify({})
      })
    );
  });
});
