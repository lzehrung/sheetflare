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

function listTableNames(database: Database.Database) {
  const rows = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
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
      },
      // Matches workerd for compatibility dates from 2026-02-24: the whole database and any alarm are removed.
      deleteAll() {
        for (const name of listTableNames(database)) {
          database.exec(`DROP TABLE "${name}"`);
        }
        alarmTimestamp = null;
        return Promise.resolve();
      }
    },
    getAlarmTimestamp() {
      return alarmTimestamp;
    },
    getTableNames() {
      return listTableNames(database);
    }
  };
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
  private readonly instances = new Map<string, {
    instance: { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> | void };
    __state: ReturnType<typeof createDurableObjectState>;
  }>();

  constructor(
    private readonly env: TEnv,
    private readonly durableObjectClass: DurableObjectClass<TEnv>
  ) {}

  idFromName(name: string) {
    return name;
  }

  get(name: string) {
    let entry = this.instances.get(name);
    if (!entry) {
      const state = createDurableObjectState();
      entry = {
        // The harness backs only `ctx.storage` (SQL, alarms, transactionSync), the part of DurableObjectState that the
        // Sheetflare Durable Objects use. Their constructors take the full workers-types DurableObjectState, whose
        // other members mean nothing here, so the double is asserted once, at this platform boundary. A Durable Object
        // that starts using another member fails its test at once instead of passing silently.
        instance: new this.durableObjectClass(state as never, this.env),
        __state: state
      };
      this.instances.set(name, entry);
    }

    return new LocalDurableObjectStub(entry.instance);
  }

  async triggerAlarm(name: string) {
    const entry = this.instances.get(name);
    if (!entry?.instance.alarm) {
      throw new Error(`Durable object ${name} does not define an alarm handler.`);
    }

    await entry.instance.alarm();
  }

  getAlarm(name: string) {
    return this.instances.get(name)?.__state.getAlarmTimestamp() ?? null;
  }

  /** Tables persisted by the named instance; an instance that was never addressed has none. */
  getStoredTableNames(name: string) {
    return this.instances.get(name)?.__state.getTableNames() ?? [];
  }

  /** Runs SQL against the named instance's storage, e.g. to seed rows written by an earlier release. */
  runSql(name: string, query: string, ...parameters: Array<string | number | boolean | null>) {
    const entry = this.instances.get(name);
    if (!entry) {
      throw new Error(`Durable object ${name} has not been created.`);
    }

    return entry.__state.storage.sql.exec(query, ...parameters).toArray();
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
