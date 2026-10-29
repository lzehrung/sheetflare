import type { ResolvedTableConfigSnapshot } from '@sheetflare/contracts';
import type { CachePurgeTarget } from '../../src/index';

type CachePurgeOptions =
  | { purgeEverything: true }
  | { tags?: string[]; pathPrefixes?: string[] };

type CachePurgeResult = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
};

type WorkerCache = {
  purge(options: CachePurgeOptions): Promise<CachePurgeResult>;
};

export type WorkerEntrypointContext<Props> = {
  props: Props;
  cache?: WorkerCache;
};

export type CachedWorkerEntrypointFetchInit = RequestInit & {
  cf?: {
    cacheKey?: string;
  };
};

export type CachedWorkerEntrypoint = {
  fetch(request: Request, init?: CachedWorkerEntrypointFetchInit): Promise<Response>;
  purge(targets: readonly CachePurgeTarget[]): Promise<void>;
};

export type CachedWorkerEntrypointProps = Readonly<{
  resolvedConfig: ResolvedTableConfigSnapshot;
  dataGeneration: number;
}>;

export type CachedWorkerEntrypointBinding = CachedWorkerEntrypoint &
  ((options: { props: CachedWorkerEntrypointProps }) => Pick<CachedWorkerEntrypoint, 'fetch'>);

const unconfiguredCachedWorkerEntrypoint: CachedWorkerEntrypoint = {
  async fetch() {
    return Response.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Cached table read test entrypoint is not configured.',
          details: null
        }
      },
      { status: 503 }
    );
  },
  async purge() {
    throw new Error('Cached table read test entrypoint is not configured.');
  }
};

const unconfiguredCachedWorkerBinding: CachedWorkerEntrypointBinding = Object.assign(
  () => unconfiguredCachedWorkerEntrypoint,
  unconfiguredCachedWorkerEntrypoint
);

// Vitest resolves `cloudflare:workers` to this module (see vitest.config.ts) and has no Workers runtime behind it, so
// the cached-read binding starts unconfigured and each test installs the entrypoint it wants to exercise.
//
// Test support imports this file by path instead of through `cloudflare:workers`. TypeScript resolves that specifier to
// the ambient module from @cloudflare/workers-types even in tests, and there `exports.CachedTableReads` is the full
// loopback stub, which a test double cannot be. The path import gives the double the type it really has and still
// reaches the module instance the gateway sees at run time. Production resolves `cloudflare:workers` to the runtime.
export const exports: {
  CachedTableReads: CachedWorkerEntrypointBinding;
} = {
  CachedTableReads: unconfiguredCachedWorkerBinding
};

export class WorkerEntrypoint<Env = Record<string, never>, Props = Record<string, never>> {
  protected readonly ctx: WorkerEntrypointContext<Props>;
  protected readonly env: Env;

  constructor(ctx: WorkerEntrypointContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
