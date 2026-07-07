type CachePurgeOptions =
  | { purgeEverything: true }
  | { tags?: string[]; pathPrefixes?: string[] };

type WorkerCache = {
  purge(options: CachePurgeOptions): Promise<void>;
};

export type WorkerEntrypointContext<Props> = {
  props: Props;
  cache?: WorkerCache;
};

export type CachedWorkerEntrypoint = {
  fetch(request: Request, init?: RequestInit): Promise<Response>;
};

export const exports: {
  CachedTableReads: CachedWorkerEntrypoint;
} = {
  CachedTableReads: {
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
    }
  }
};

export class WorkerEntrypoint<Env = Record<string, never>, Props = Record<string, never>> {
  protected readonly ctx: WorkerEntrypointContext<Props>;
  protected readonly env: Env;

  constructor(ctx: WorkerEntrypointContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
