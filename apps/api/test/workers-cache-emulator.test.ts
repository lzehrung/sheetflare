import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkersCacheEmulator } from './support/workers-cache';

const startedAt = Date.parse('2026-10-29T12:00:00.000Z');

function cacheableResponse(body: string, options: { maxAge: number; tags?: string[] }) {
  return new Response(body, {
    headers: {
      'cache-control': 'private, no-store',
      'cloudflare-cdn-cache-control': `public, max-age=${options.maxAge}`,
      'cache-tag': (options.tags ?? []).join(',')
    }
  });
}

/** Serves `responses` in order, one per run, and counts how often the entrypoint ran. */
function createEntrypoint(...responses: Array<() => Response>) {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    run: async () => {
      const respond = responses[Math.min(runs, responses.length - 1)];
      runs += 1;
      if (respond === undefined) {
        throw new Error('The test entrypoint has no response.');
      }
      return respond();
    }
  };
}

function get(path: string) {
  return new Request(`https://cached.sheetflare.internal${path}`);
}

describe('WorkersCacheEmulator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('purge rate limit', () => {
    it('accepts a burst of 25 purges and then rejects with success: false', async () => {
      const cache = new WorkersCacheEmulator();

      for (let purge = 0; purge < 25; purge += 1) {
        await expect(cache.purge({ tags: [`table:${purge}`] })).resolves.toEqual({ success: true, errors: [] });
      }
      const rejected = await cache.purge({ tags: ['table:26'] });

      expect(rejected.success).toBe(false);
      expect(rejected.errors).toEqual([expect.objectContaining({ code: 429 })]);
      expect(cache.purgeRequests.filter((request) => request.accepted)).toHaveLength(25);
      expect(cache.purgeRequests).toHaveLength(26);
    });

    it('refills five purges per minute, one every 12 seconds', async () => {
      const cache = new WorkersCacheEmulator();
      for (let purge = 0; purge < 25; purge += 1) {
        await cache.purge({ tags: ['table:demo'] });
      }

      vi.advanceTimersByTime(11_000);
      expect((await cache.purge({ tags: ['table:demo'] })).success).toBe(false);

      vi.advanceTimersByTime(1_000);
      expect((await cache.purge({ tags: ['table:demo'] })).success).toBe(true);
      expect((await cache.purge({ tags: ['table:demo'] })).success).toBe(false);

      vi.advanceTimersByTime(60_000);
      const accepted = [];
      for (let purge = 0; purge < 6; purge += 1) {
        accepted.push((await cache.purge({ tags: ['table:demo'] })).success);
      }
      expect(accepted).toEqual([true, true, true, true, true, false]);
    });

    it('never holds more than the burst, however long it idles', async () => {
      const cache = new WorkersCacheEmulator();

      vi.advanceTimersByTime(60 * 60_000);
      const accepted = [];
      for (let purge = 0; purge < 30; purge += 1) {
        accepted.push((await cache.purge({ tags: ['table:demo'] })).success);
      }

      expect(accepted.filter(Boolean)).toHaveLength(25);
    });

    it('limits one request to 100 tags without charging the bucket for the rejected request', async () => {
      const cache = new WorkersCacheEmulator();
      const tags = Array.from({ length: 101 }, (_, index) => `project:${index}`);

      const tooMany = await cache.purge({ tags });
      expect(tooMany.success).toBe(false);
      expect(tooMany.errors).toEqual([expect.objectContaining({ code: 400 })]);
      expect((await cache.purge({ tags: [] })).success).toBe(false);

      for (let purge = 0; purge < 25; purge += 1) {
        expect((await cache.purge({ tags: tags.slice(0, 100) })).success).toBe(true);
      }
      expect((await cache.purge({ tags: ['project:0'] })).success).toBe(false);
    });

    it('refuses purge modes it does not model instead of silently ignoring them', async () => {
      const cache = new WorkersCacheEmulator();

      await expect(cache.purge({ purgeEverything: true })).rejects.toThrow('only models purging by tag');
      await expect(cache.purge({ pathPrefixes: ['/internal/'] })).rejects.toThrow('only models purging by tag');
    });
  });

  describe('storage and keys', () => {
    it('serves a stored response without running the entrypoint', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('first', { maxAge: 30 }), () => cacheableResponse('second', { maxAge: 30 }));

      const miss = await cache.fetch({ props: null, cacheKey: null, request: get('/rows'), run: entrypoint.run });
      const hit = await cache.fetch({ props: null, cacheKey: null, request: get('/rows'), run: entrypoint.run });

      expect(miss.headers.get('cf-cache-status')).toBe('MISS');
      expect(await miss.text()).toBe('first');
      expect(hit.headers.get('cf-cache-status')).toBe('HIT');
      expect(await hit.text()).toBe('first');
      expect(entrypoint.runs).toBe(1);
    });

    it('keys entries by cf.cacheKey instead of the request URL', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('shared', { maxAge: 30 }), () => cacheableResponse('other', { maxAge: 30 }));

      await cache.fetch({ props: null, cacheKey: 'rows?gen=1', request: get('/a'), run: entrypoint.run });
      const sameKeyOtherUrl = await cache.fetch({ props: null, cacheKey: 'rows?gen=1', request: get('/b'), run: entrypoint.run });
      const otherKeySameUrl = await cache.fetch({ props: null, cacheKey: 'rows?gen=2', request: get('/a'), run: entrypoint.run });

      expect(sameKeyOtherUrl.headers.get('cf-cache-status')).toBe('HIT');
      expect(await sameKeyOtherUrl.text()).toBe('shared');
      expect(otherKeySameUrl.headers.get('cf-cache-status')).toBe('MISS');
      expect(await otherKeySameUrl.text()).toBe('other');
      expect(cache.entries().map((entry) => entry.cacheKey).sort()).toEqual(['rows?gen=1', 'rows?gen=2']);
    });

    it('keys entries by the invocation props as well', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('tenant-a', { maxAge: 30 }), () => cacheableResponse('tenant-b', { maxAge: 30 }));

      await cache.fetch({ props: { tenant: 'a' }, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });
      const other = await cache.fetch({ props: { tenant: 'b' }, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });

      expect(other.headers.get('cf-cache-status')).toBe('MISS');
      expect(await other.text()).toBe('tenant-b');
    });

    it('expires an entry after its max-age, counted from when the response was produced', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('old', { maxAge: 10 }), () => cacheableResponse('new', { maxAge: 10 }));
      await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });

      vi.advanceTimersByTime(9_999);
      expect((await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run })).headers.get('cf-cache-status')).toBe('HIT');
      vi.advanceTimersByTime(1);
      const expired = await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });

      expect(expired.headers.get('cf-cache-status')).toBe('EXPIRED');
      expect(await expired.text()).toBe('new');
      expect(entrypoint.runs).toBe(2);
    });

    it.each([
      { name: 'Cloudflare-CDN-Cache-Control: no-store', headers: { 'cloudflare-cdn-cache-control': 'no-store', 'cache-control': 'public, max-age=60' } },
      { name: 'Cache-Control: private', headers: { 'cache-control': 'private, max-age=60' } },
      { name: 'Cache-Control: no-store', headers: { 'cache-control': 'no-store' } },
      { name: 'max-age=0', headers: { 'cache-control': 'public, max-age=0' } }
    ])('does not store a response with $name', async ({ headers }) => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => new Response('body', { headers }));

      const first = await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });
      await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });

      expect(first.headers.get('cf-cache-status')).toBe('BYPASS');
      expect(entrypoint.runs).toBe(2);
      expect(cache.entries()).toEqual([]);
    });

    it('lets Cloudflare-CDN-Cache-Control override a private Cache-Control, as the entrypoint relies on', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('body', { maxAge: 20 }));

      await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });

      expect(cache.entries()).toEqual([expect.objectContaining({ maxAgeSeconds: 20 })]);
    });

    it('applies the 2 hour heuristic to a 200 without Cache-Control, but not to errors', async () => {
      const cache = new WorkersCacheEmulator();
      await cache.fetch({ props: null, cacheKey: 'ok', request: get('/ok'), run: async () => new Response('ok') });
      await cache.fetch({ props: null, cacheKey: 'missing', request: get('/missing'), run: async () => new Response('missing', { status: 500 }) });

      expect(cache.entries()).toEqual([expect.objectContaining({ cacheKey: 'ok', maxAgeSeconds: 7200 })]);
    });

    it('never caches anything but GET', async () => {
      const cache = new WorkersCacheEmulator();
      const entrypoint = createEntrypoint(() => cacheableResponse('body', { maxAge: 30 }));

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await cache.fetch({
          props: null,
          cacheKey: 'rows',
          request: new Request('https://cached.sheetflare.internal/rows', { method: 'POST' }),
          run: entrypoint.run
        });
        expect(response.headers.get('cf-cache-status')).toBe('BYPASS');
      }

      expect(entrypoint.runs).toBe(2);
    });

    it('drops invalid tags when it stores an entry and keeps the valid ones', async () => {
      const cache = new WorkersCacheEmulator();
      const longTag = 'x'.repeat(1025);
      await cache.fetch({
        props: null,
        cacheKey: 'rows',
        request: get('/rows'),
        run: async () => cacheableResponse('body', { maxAge: 30, tags: ['Project:Demo', longTag, 'has space', 'table:demo:users'] })
      });

      expect(cache.entries()[0]?.tags).toEqual(['project:demo', 'table:demo:users']);
    });
  });

  describe('purging by tag', () => {
    async function storeEntries(cache: WorkersCacheEmulator) {
      const tagsByKey = {
        'users-list': ['project:demo', 'table:demo:users'],
        'users-row-1': ['project:demo', 'table:demo:users', 'row:demo:users:row-1'],
        'orders-list': ['project:demo', 'table:demo:orders'],
        'other-project': ['project:other', 'table:other:users']
      };
      for (const [cacheKey, tags] of Object.entries(tagsByKey)) {
        await cache.fetch({
          props: null,
          cacheKey,
          request: get(`/${cacheKey}`),
          run: async () => cacheableResponse(cacheKey, { maxAge: 60, tags })
        });
      }
    }

    it('deletes exactly the entries that carry a purged tag', async () => {
      const cache = new WorkersCacheEmulator();
      await storeEntries(cache);

      await cache.purge({ tags: ['table:demo:users'] });

      expect(cache.entries().map((entry) => entry.cacheKey).sort()).toEqual(['orders-list', 'other-project']);
    });

    it('unions several tags in one request', async () => {
      const cache = new WorkersCacheEmulator();
      await storeEntries(cache);

      await cache.purge({ tags: ['row:demo:users:row-1', 'table:demo:orders'] });

      expect(cache.entries().map((entry) => entry.cacheKey).sort()).toEqual(['other-project', 'users-list']);
    });

    it('matches tags case-insensitively', async () => {
      const cache = new WorkersCacheEmulator();
      await storeEntries(cache);

      await cache.purge({ tags: ['PROJECT:Demo'] });

      expect(cache.entries().map((entry) => entry.cacheKey)).toEqual(['other-project']);
    });

    it('leaves entries alone when a rejected purge never reached the cache', async () => {
      const cache = new WorkersCacheEmulator({ purgeBurst: 0 });
      await storeEntries(cache);

      expect((await cache.purge({ tags: ['project:demo'] })).success).toBe(false);

      expect(cache.entries()).toHaveLength(4);
    });

    it('does not reach a response that is still being produced, which the entrypoint must not depend on', async () => {
      const cache = new WorkersCacheEmulator();
      const hold = cache.holdFills();
      const entrypoint = createEntrypoint(() => cacheableResponse('pre-write', { maxAge: 60, tags: ['table:demo:users'] }));

      const inFlight = await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });
      await cache.purge({ tags: ['table:demo:users'] });
      await hold.release();

      expect(await inFlight.text()).toBe('pre-write');
      const later = await cache.fetch({ props: null, cacheKey: 'rows', request: get('/rows'), run: entrypoint.run });
      expect(later.headers.get('cf-cache-status')).toBe('HIT');
      expect(await later.text()).toBe('pre-write');
    });
  });
});
