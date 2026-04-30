import Database from 'better-sqlite3';

type SqlRow = Record<string, unknown>;

class SqlResult {
  constructor(private readonly rows: SqlRow[]) {}

  toArray() {
    return [...this.rows];
  }

  one() {
    if (this.rows.length !== 1) {
      throw new Error(
        this.rows.length === 0
          ? 'Expected exactly one result from SQL query, but got no results.'
          : `Expected exactly one result from SQL query, but got ${this.rows.length} results.`
      );
    }

    return this.rows[0];
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
  let alarmTimestamp: number | null = null;
  return {
    storage: {
      sql: new SqlStorageHarness(database),
      transactionSync<T>(callback: () => T) {
        const transaction = database.transaction(callback);
        return transaction();
      },
      getAlarm() {
        return Promise.resolve(alarmTimestamp);
      },
      setAlarm(scheduledTime: number | Date) {
        alarmTimestamp = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
        return Promise.resolve();
      },
      deleteAlarm() {
        alarmTimestamp = null;
        return Promise.resolve();
      }
    }
  } as DurableObjectState;
}

export type DurableObjectClass<TEnv> = new (state: DurableObjectState, env: TEnv) => {
  fetch(request: Request): Promise<Response>;
  alarm?(): Promise<void> | void;
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
  private readonly instances = new Map<string, { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> | void }>();

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

  async triggerAlarm(name: string) {
    const instance = this.instances.get(name);
    if (!instance?.alarm) {
      throw new Error(`Durable object ${name} does not define an alarm handler.`);
    }

    await instance.alarm();
  }
}

export function createDurableObjectNamespace<TEnv>(
  env: TEnv,
  durableObjectClass: DurableObjectClass<TEnv>
) {
  return new LocalDurableObjectNamespace(env, durableObjectClass);
}

export async function triggerDurableObjectAlarm<TEnv>(
  namespace: ReturnType<typeof createDurableObjectNamespace<TEnv>>,
  name: string
) {
  await namespace.triggerAlarm(name);
}
