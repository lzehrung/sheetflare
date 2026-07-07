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

export class WorkerEntrypoint<Env = Record<string, never>, Props = Record<string, never>> {
  protected readonly ctx: WorkerEntrypointContext<Props>;
  protected readonly env: Env;

  constructor(ctx: WorkerEntrypointContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
