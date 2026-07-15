import type { ResolvedTableConfigSnapshot } from '@sheetflare/contracts';

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
  invalidateProject(projectSlug: string): Promise<void>;
  invalidateTable(projectSlug: string, tableSlug: string): Promise<void>;
  invalidateRow(projectSlug: string, tableSlug: string, rowId: string): Promise<void>;
};

export type CachedWorkerEntrypointProps = Readonly<{
  resolvedConfig: ResolvedTableConfigSnapshot;
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
  async invalidateProject() {
    throw new Error('Cached table read test entrypoint is not configured.');
  },
  async invalidateTable() {
    throw new Error('Cached table read test entrypoint is not configured.');
  },
  async invalidateRow() {
    throw new Error('Cached table read test entrypoint is not configured.');
  }
};

const unconfiguredCachedWorkerBinding: CachedWorkerEntrypointBinding = Object.assign(
  () => unconfiguredCachedWorkerEntrypoint,
  unconfiguredCachedWorkerEntrypoint
);

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
