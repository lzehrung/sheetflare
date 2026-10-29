/**
 * An in-memory model of the Workers Cache that sits in front of the `CachedTableReads` entrypoint, written from
 * Cloudflare's documentation (https://developers.cloudflare.com/workers/cache/):
 *
 * - A miss runs the entrypoint and stores the response when its headers allow it. A hit never runs the entrypoint.
 *   `Cloudflare-CDN-Cache-Control` replaces `Cache-Control` for this cache (RFC 9213).
 * - An entry is keyed by the invocation's `ctx.props` plus `cf.cacheKey`, which replaces the request's path and query.
 * - `Cache-Tag` labels an entry; tags are case-insensitive, at most 1024 printable ASCII characters, at most 1000 per
 *   response, and invalid ones are dropped when the entry is stored.
 * - `purge({ tags })` deletes the entries that carry any of the tags. It only reaches entries that are already stored,
 *   so a response still being produced when the purge runs is stored afterwards (the purge-before-fill race).
 * - `purge()` always uses Cloudflare's Free-tier limits: a token bucket of 25 requests refilled at 5 per minute, and
 *   at most 100 tags per request. A purge that finds the bucket empty is rejected with `success: false`.
 *
 * It is a test double, not proof of how production behaves: staging validation stays required.
 */

const defaultPurgeBurst = 25;
const defaultPurgeRefillPerMinute = 5;
const defaultMaxTagsPerPurge = 100;
// One purge token is 60 000 ticks and each elapsed millisecond refills `purgeRefillPerMinute` ticks, which makes the
// refill rate exact integer arithmetic instead of floating point that drifts at a token boundary.
const ticksPerToken = 60_000;
const maxTagLength = 1024;
const maxTagsPerResponse = 1000;
// RFC 9111 heuristic freshness Cloudflare applies to a 200 that carries no Cache-Control at all.
const heuristicTtlSeconds = 7200;

export type WorkersCacheOptions = {
  /** Tokens in a full purge bucket. */
  purgeBurst?: number;
  /** Tokens the purge bucket regains per minute. */
  purgeRefillPerMinute?: number;
  /** Most tags one purge request may carry. */
  maxTagsPerPurge?: number;
  /** Current time in milliseconds. Defaults to `Date.now`, so vitest fake timers drive it. */
  now?: () => number;
};

export type WorkersCacheFetch = {
  /** `ctx.props` of the invocation. It is part of the cache key. */
  props: unknown;
  /** `cf.cacheKey` of the caller. It replaces the request's path and query in the cache key. */
  cacheKey: string | null;
  request: Request;
  /** Runs the entrypoint. The cache does this only on a miss. */
  run(): Promise<Response>;
};

export type PurgeRequestRecord = {
  tags: string[];
  /** False when the emulated purge API rejected the request. */
  accepted: boolean;
  atMs: number;
};

export type WorkersCacheEntry = {
  cacheKey: string;
  requestPath: string;
  /** Lowercased, as Cloudflare matches tags case-insensitively. */
  tags: string[];
  maxAgeSeconds: number;
  /** When the entrypoint produced the response. Freshness counts from here, not from when the entry was stored. */
  generatedAtMs: number;
  expiresAtMs: number;
};

type StoredEntry = WorkersCacheEntry & {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
};

export type FillHold = {
  /** Lets the held fills store their entries and waits until they are stored. */
  release(): Promise<void>;
};

function parseCacheControl(value: string) {
  const directives = new Map<string, string | true>();
  for (const part of value.split(',')) {
    const directive = part.trim().toLowerCase();
    if (directive === '') {
      continue;
    }

    const separator = directive.indexOf('=');
    if (separator === -1) {
      directives.set(directive, true);
    } else {
      directives.set(directive.slice(0, separator), directive.slice(separator + 1));
    }
  }
  return directives;
}

/** Seconds the cache may keep the response, or null when its headers forbid storing it. */
function readEdgeTtlSeconds(response: Response) {
  const header = response.headers.get('cloudflare-cdn-cache-control')
    ?? response.headers.get('cdn-cache-control')
    ?? response.headers.get('cache-control');
  if (header === null) {
    return response.status === 200 ? heuristicTtlSeconds : null;
  }

  const directives = parseCacheControl(header);
  if (directives.has('no-store') || directives.has('private') || directives.has('no-cache')) {
    return null;
  }

  const maxAge = directives.get('s-maxage') ?? directives.get('max-age');
  const seconds = typeof maxAge === 'string' ? Number(maxAge) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
}

function isPrintableAscii(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}

function readCacheTags(response: Response) {
  const header = response.headers.get('cache-tag') ?? '';
  return header
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= maxTagLength && isPrintableAscii(tag))
    .slice(0, maxTagsPerResponse)
    .map((tag) => tag.toLowerCase());
}

function withCacheStatus(response: Response, status: 'HIT' | 'MISS' | 'EXPIRED' | 'BYPASS') {
  const headers = new Headers(response.headers);
  headers.set('cf-cache-status', status);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function rejectedPurge(code: number, message: string): CachePurgeResult {
  return { success: false, errors: [{ code, message }] };
}

export class WorkersCacheEmulator {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #purgeRequests: PurgeRequestRecord[] = [];
  readonly #pendingFills: Array<Promise<void>> = [];
  readonly #capacity: number;
  readonly #refillPerMinute: number;
  readonly #maxTagsPerPurge: number;
  readonly #now: () => number;
  // Counted in ticks, see `ticksPerToken`.
  #ticks: number;
  #lastRefillMs: number;
  #fillGate: Promise<void> | null = null;

  constructor(options: WorkersCacheOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#capacity = (options.purgeBurst ?? defaultPurgeBurst) * ticksPerToken;
    this.#refillPerMinute = options.purgeRefillPerMinute ?? defaultPurgeRefillPerMinute;
    this.#maxTagsPerPurge = options.maxTagsPerPurge ?? defaultMaxTagsPerPurge;
    this.#ticks = this.#capacity;
    this.#lastRefillMs = this.#now();
  }

  /** Every purge request that reached the purge API, accepted or not, in order. */
  get purgeRequests(): readonly PurgeRequestRecord[] {
    return this.#purgeRequests;
  }

  /** Entries that are stored and still fresh. */
  entries(): WorkersCacheEntry[] {
    const nowMs = this.#now();
    return [...this.#entries.values()]
      .filter((entry) => entry.expiresAtMs > nowMs)
      .map(({ cacheKey, requestPath, tags, maxAgeSeconds, generatedAtMs, expiresAtMs }) => ({
        cacheKey,
        requestPath,
        tags,
        maxAgeSeconds,
        generatedAtMs,
        expiresAtMs
      }));
  }

  /**
   * Stores responses only once `release()` is called. A response produced meanwhile reaches its caller at once, which
   * is how a read that is in flight when a write commits and purges ends up stored after the purge.
   */
  holdFills(): FillHold {
    const gate = Promise.withResolvers<void>();
    this.#fillGate = gate.promise;
    return {
      release: async () => {
        this.#fillGate = null;
        gate.resolve();
        await Promise.all(this.#pendingFills.splice(0));
      }
    };
  }

  async fetch(call: WorkersCacheFetch): Promise<Response> {
    if (call.request.method !== 'GET') {
      return withCacheStatus(await call.run(), 'BYPASS');
    }

    const url = new URL(call.request.url);
    const requestPath = url.pathname + url.search;
    const cacheKey = call.cacheKey ?? requestPath;
    const storageKey = JSON.stringify([call.props, cacheKey]);

    const stored = this.#entries.get(storageKey);
    if (stored !== undefined && stored.expiresAtMs > this.#now()) {
      return withCacheStatus(new Response(stored.body, {
        status: stored.status,
        statusText: stored.statusText,
        headers: stored.headers
      }), 'HIT');
    }
    this.#entries.delete(storageKey);

    const response = await call.run();
    const generatedAtMs = this.#now();
    const ttlSeconds = readEdgeTtlSeconds(response);
    if (ttlSeconds === null) {
      return withCacheStatus(response, 'BYPASS');
    }

    const fill = this.#store(storageKey, {
      cacheKey,
      requestPath,
      tags: readCacheTags(response),
      maxAgeSeconds: ttlSeconds,
      generatedAtMs,
      expiresAtMs: generatedAtMs + ttlSeconds * 1000
    }, response.clone());
    if (this.#fillGate === null) {
      await fill;
    } else {
      this.#pendingFills.push(fill);
    }
    return withCacheStatus(response, stored === undefined ? 'MISS' : 'EXPIRED');
  }

  async purge(options: CachePurgeOptions): Promise<CachePurgeResult> {
    if (options.purgeEverything !== undefined || options.pathPrefixes !== undefined) {
      throw new Error('WorkersCacheEmulator only models purging by tag.');
    }

    const tags = options.tags ?? [];
    const nowMs = this.#now();
    if (tags.length === 0 || tags.length > this.#maxTagsPerPurge) {
      this.#purgeRequests.push({ tags: [...tags], accepted: false, atMs: nowMs });
      return rejectedPurge(400, `A purge request must carry between 1 and ${this.#maxTagsPerPurge} tags.`);
    }

    if (!this.#takePurgeToken(nowMs)) {
      this.#purgeRequests.push({ tags: [...tags], accepted: false, atMs: nowMs });
      return rejectedPurge(429, 'Purge rate limit exceeded.');
    }

    this.#purgeRequests.push({ tags: [...tags], accepted: true, atMs: nowMs });
    const purged = new Set(tags.map((tag) => tag.toLowerCase()));
    for (const [storageKey, entry] of this.#entries) {
      if (entry.tags.some((tag) => purged.has(tag))) {
        this.#entries.delete(storageKey);
      }
    }
    return { success: true, errors: [] };
  }

  #takePurgeToken(nowMs: number) {
    const elapsedMs = Math.max(0, nowMs - this.#lastRefillMs);
    this.#ticks = Math.min(this.#capacity, this.#ticks + elapsedMs * this.#refillPerMinute);
    this.#lastRefillMs = nowMs;
    if (this.#ticks < ticksPerToken) {
      return false;
    }

    this.#ticks -= ticksPerToken;
    return true;
  }

  async #store(storageKey: string, entry: WorkersCacheEntry, response: Response) {
    const body = await response.text();
    if (this.#fillGate !== null) {
      await this.#fillGate;
    }

    this.#entries.set(storageKey, {
      ...entry,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body
    });
  }
}
