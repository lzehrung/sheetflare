import Database from 'better-sqlite3';

type SqlRow = Record<string, unknown>;

class SqlResult {
  constructor(private readonly rows: SqlRow[]) {}

  toArray() {
    return [...this.rows];
  }

  one() {
    return this.rows[0] ?? null;
  }
}

class SqlStorageHarness {
  constructor(private readonly database: Database.Database) {}

  exec(sql: string, ...parameters: Array<string | number | boolean | null>) {
    const trimmed = sql.trimStart();
    const statement = this.database.prepare(sql);

    if (/^(SELECT|WITH)\b/i.test(trimmed)) {
      return new SqlResult(statement.all(...parameters) as SqlRow[]);
    }

    statement.run(...parameters);
    return new SqlResult([]);
  }
}

function createDurableObjectState() {
  const database = new Database(':memory:');
  return {
    storage: {
      sql: new SqlStorageHarness(database)
    }
  } as DurableObjectState;
}

export type DurableObjectClass<TEnv> = new (state: DurableObjectState, env: TEnv) => {
  fetch(request: Request): Promise<Response>;
};

class LocalDurableObjectStub {
  constructor(
    private readonly instance: { fetch(request: Request): Promise<Response> }
  ) {}

  fetch(input: RequestInfo | URL, init?: RequestInit) {
    return this.instance.fetch(new Request(input, init));
  }
}

class LocalDurableObjectNamespace<TEnv> {
  private readonly instances = new Map<string, { fetch(request: Request): Promise<Response> }>();

  constructor(
    private readonly env: TEnv,
    private readonly durableObjectClass: DurableObjectClass<TEnv>
  ) {}

  idFromName(name: string) {
    return name;
  }

  get(name: string) {
    let instance = this.instances.get(name);
    if (!instance) {
      instance = new this.durableObjectClass(createDurableObjectState(), this.env);
      this.instances.set(name, instance);
    }

    return new LocalDurableObjectStub(instance);
  }
}

export function createDurableObjectNamespace<TEnv>(
  env: TEnv,
  durableObjectClass: DurableObjectClass<TEnv>
) {
  return new LocalDurableObjectNamespace(env, durableObjectClass);
}
