// The real gateway (`createApp()`) in front of the real ControlPlaneDO, ProjectDO, TableDO and RateLimitDO, each
// backed by its own in-memory SQLite database. Google is the only fake, and it sits at the fetch boundary, so the real
// GoogleSheetsService still signs its JWT and speaks the real request shapes.
//
// Unlike the canned namespaces in harness.ts, nothing here answers on behalf of a Durable Object: the control plane
// really stores and compares key hashes, the project Durable Object really creates and deletes projects, and so on.

import { exports as workerExports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { z } from 'zod';
import { doRpc } from '@sheetflare/cloudflare';
import {
  adminCreateApiKeyResultSchema,
  type ApiKeyPrincipal,
  type ApiScope,
  type ControlPlaneDoRequest,
  type ControlPlaneDoResponse
} from '@sheetflare/contracts';
import { createDurableObjectNamespace } from '../../../../packages/cloudflare/test/support/do-harness';
import type { Env } from '../../src/env';
import {
  __resetGatewayStateForTests,
  ControlPlaneDO,
  createApp,
  ProjectDO,
  RateLimitDO,
  TableDO,
  type CachedTableReadProps
} from '../../src/index';
import { createCachedTableReadsHarness, type CachePurgeCall } from './harness';

const bootstrapToken = 'real-stack-bootstrap-token';

// ---------------------------------------------------------------------------------------------------------------
// Google, faked at the fetch boundary
// ---------------------------------------------------------------------------------------------------------------

export type FakeTab = { title: string; sheetGid: number; rows: string[][] };

export type GoogleRequestRecord = { method: string; url: string };

export type FakeGoogle = {
  /** Every request that reached Google, in order, including OAuth token requests. */
  readonly requests: readonly GoogleRequestRecord[];
  addSpreadsheet(spreadsheetId: string, tabs: readonly FakeTab[]): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

const fakeAccessToken = 'fake-google-access-token';
const googleStatusNames = { 401: 'UNAUTHENTICATED', 404: 'NOT_FOUND' } as const;
const spreadsheetPathPattern = /^\/v4\/spreadsheets\/([^/]+)$/;
const valuesPathPattern = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/;
// `'Tab'!A1:C`, `'Tab'!1:1`, `'Tab'!A2:A`, `'Tab'!A2:C2`: either column or either row may be omitted.
const a1RangePattern = /^'((?:[^']|'')+)'!([A-Z]*)(\d*):([A-Z]*)(\d*)$/;

function googleError(status: keyof typeof googleStatusNames, message: string) {
  return Response.json({ error: { code: status, message, status: googleStatusNames[status] } }, { status });
}

function columnIndex(letters: string) {
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function trimTrailingEmptyCells(cells: string[]) {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') {
    end -= 1;
  }
  return cells.slice(0, end);
}

// Google omits trailing empty cells and rows from a values response.
function readRange(tab: FakeTab, [, , startColumn = '', startRow = '', endColumn = '', endRow = '']: RegExpExecArray) {
  const firstRow = startRow === '' ? 1 : Number(startRow);
  const lastRow = endRow === '' ? tab.rows.length : Number(endRow);
  const firstColumn = startColumn === '' ? 0 : columnIndex(startColumn);
  const widestRow = Math.max(0, ...tab.rows.map((row) => row.length));
  const lastColumn = endColumn === '' ? widestRow - 1 : columnIndex(endColumn);

  const rows = tab.rows
    .slice(firstRow - 1, lastRow)
    .map((row) => trimTrailingEmptyCells(row.slice(firstColumn, lastColumn + 1)));
  while (rows.length > 0 && rows[rows.length - 1]?.length === 0) {
    rows.pop();
  }
  return rows;
}

function createFakeGoogle(): FakeGoogle {
  const spreadsheets = new Map<string, readonly FakeTab[]>();
  const requests: GoogleRequestRecord[] = [];

  async function handleOAuthToken(request: Request) {
    const form = new URLSearchParams(await request.text());
    const assertion = form.get('assertion');
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || assertion?.split('.').length !== 3) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.json({ access_token: fakeAccessToken, expires_in: 3600, token_type: 'Bearer' });
  }

  function handleSheets(request: Request, url: URL) {
    if (request.headers.get('authorization') !== `Bearer ${fakeAccessToken}`) {
      return googleError(401, 'Request had invalid authentication credentials.');
    }

    const valuesMatch = valuesPathPattern.exec(url.pathname);
    const spreadsheetMatch = spreadsheetPathPattern.exec(url.pathname);
    const spreadsheetId = decodeURIComponent(valuesMatch?.[1] ?? spreadsheetMatch?.[1] ?? '');
    const tabs = spreadsheets.get(spreadsheetId);
    if (tabs === undefined) {
      return googleError(404, 'Requested entity was not found.');
    }

    if (spreadsheetMatch) {
      return Response.json({
        sheets: tabs.map((tab) => ({ properties: { sheetId: tab.sheetGid, title: tab.title, sheetType: 'GRID' } }))
      });
    }

    const range = decodeURIComponent(valuesMatch?.[2] ?? '');
    const a1 = a1RangePattern.exec(range);
    const tab = tabs.find((candidate) => candidate.title === a1?.[1]?.replace(/''/g, "'"));
    if (!a1 || !tab) {
      return googleError(404, `Unable to parse range: ${range}`);
    }

    const values = readRange(tab, a1);
    return Response.json({ range, majorDimension: 'ROWS', ...(values.length > 0 ? { values } : {}) });
  }

  return {
    requests,
    addSpreadsheet(spreadsheetId, tabs) {
      spreadsheets.set(spreadsheetId, tabs);
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, url: request.url });

      if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && request.method === 'POST') {
        return handleOAuthToken(request);
      }
      if (url.origin === 'https://sheets.googleapis.com' && request.method === 'GET') {
        return handleSheets(request, url);
      }
      // Anything else (writes, Drive watches) is outside what the auth scenarios need, so it fails loudly in the
      // recorded requests instead of being silently accepted.
      return googleError(404, `Unexpected Google request in test: ${request.method} ${request.url}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Durable Objects: real classes, observed at the stub boundary
// ---------------------------------------------------------------------------------------------------------------

type DurableObjectTarget = 'control-plane' | 'project' | 'table' | 'rate-limit';

const rpcBodySchema = z.looseObject({ type: z.string() });

export type RpcRecord = {
  target: DurableObjectTarget;
  /** Durable Object instance name, for example `project:demo`. */
  name: string;
  body: z.infer<typeof rpcBodySchema>;
};

/** The two namespace members the gateway and the Durable Objects call; `createDurableObjectNamespace` provides them. */
interface InMemoryNamespace {
  idFromName(name: string): string;
  get(name: string): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

// Forwards every call to the real in-memory namespace and only records the RPC body on the way through, so a test can
// say what the gateway sent without replacing what answered.
function observe(target: DurableObjectTarget, namespace: InMemoryNamespace, log: RpcRecord[]): InMemoryNamespace {
  return {
    idFromName(name) {
      return namespace.idFromName(name);
    },
    get(name) {
      const stub = namespace.get(name);
      return {
        async fetch(input, init) {
          const request = new Request(input, init);
          log.push({ target, name, body: rpcBodySchema.parse(await request.clone().json()) });
          return stub.fetch(request);
        }
      };
    }
  };
}

// workers-types declares many more members on `DurableObjectNamespace` than the two above, so the binding type is
// asserted here, once, at the Cloudflare binding boundary. Nothing else in the stack relies on an assertion.
function asBinding(namespace: InMemoryNamespace): Env['CONTROL_PLANE_DO'] {
  return namespace as never;
}

// ---------------------------------------------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------------------------------------------

// A service-account key is parsed and used to sign a real JWT, so the key has to be a valid PKCS#8 RSA key.
async function generateServiceAccountPrivateKey() {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8));
  return ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/g) ?? []), '-----END PRIVATE KEY-----'].join('\n');
}

const serviceAccountPrivateKey = await generateServiceAccountPrivateKey();

export type RequestOptions = { method?: string; json?: unknown };

export type ProvisionOptions = {
  slug: string;
  /** Cells of the project's only tab. The first row is the header row and must contain `_id`. */
  rows: string[][];
  tableSlug?: string;
  sheetTabName?: string;
  spreadsheetId?: string;
};

export type MintKeyInput = { name: string; projectSlug: string | null; scopes: ApiScope[] };

export type MintedKey = {
  /** The full `sfk_<id>.<secret>` credential, as returned once by `POST /v1/admin/keys`. */
  credential: string;
  id: string;
  secret: string;
  record: ApiKeyPrincipal;
};

export type RealStack = {
  readonly env: Env;
  readonly bootstrapToken: string;
  readonly google: FakeGoogle;
  /** Arguments of every Workers Cache purge the gateway asked for. */
  readonly purgeCalls: readonly CachePurgeCall[];
  /**
   * Every RPC the gateway and the Durable Objects sent to a Durable Object, in order. Calls made through
   * `controlPlane.rpc` are not included.
   */
  readonly rpcs: readonly RpcRecord[];
  rpcsOf(type: string): RpcRecord[];
  clearRpcs(): void;
  /**
   * Returns a function that sends one request through the gateway, as `credential` (a bootstrap token or an API key)
   * or anonymously when `null`.
   */
  requestAs(credential: string | null): (path: string, options?: RequestOptions) => Promise<Response>;
  /** Creates a project and one table over the admin API, as the bootstrap admin. Throws unless both are created. */
  provision(options: ProvisionOptions): Promise<void>;
  /**
   * Mints a key over the admin API, as the bootstrap admin unless `credential` says otherwise. Throws unless the key
   * is created.
   */
  mintKey(input: MintKeyInput, credential?: string): Promise<MintedKey>;
  /**
   * Models the next request landing on a Worker isolate that has not verified any key yet. `createApp()` alone does
   * not do this: the verified-principal cache lives at module level, like it does for an isolate.
   */
  freshIsolate(): void;
  controlPlane: {
    /** Talks to the control plane Durable Object directly, the way another isolate's gateway would. */
    rpc(body: ControlPlaneDoRequest): Promise<ControlPlaneDoResponse>;
    /** Runs SQL against the control plane's storage, e.g. to put it in a state an earlier release left behind. */
    sql(query: string, ...parameters: Array<string | number | boolean | null>): Record<string, unknown>[];
  };
  /** Tables the named project Durable Object has persisted; empty for an object that never wrote anything. */
  projectStorage(projectSlug: string): string[];
};

const apiKeyPattern = /^sfk_([0-9a-f-]{36})\.([0-9a-f]{64})$/;

export function createRealStack(): RealStack {
  const google = createFakeGoogle();
  const rpcs: RpcRecord[] = [];
  const purgeCalls: CachePurgeCall[] = [];
  vi.stubGlobal('fetch', google.fetch);
  // A new stack is a new deployment, so no isolate has verified a key yet.
  __resetGatewayStateForTests();

  // The Durable Objects are constructed with the same `env` the gateway receives, like a deployed Worker, so the
  // bindings resolve lazily once all four namespaces exist.
  const bindings: Partial<Record<DurableObjectTarget, Env['CONTROL_PLANE_DO']>> = {};
  function binding(target: DurableObjectTarget) {
    const found = bindings[target];
    if (found === undefined) {
      throw new Error(`The ${target} namespace is not bound yet.`);
    }
    return found;
  }
  const env: Env = {
    get CONTROL_PLANE_DO() {
      return binding('control-plane');
    },
    get PROJECT_DO() {
      return binding('project');
    },
    get TABLE_DO() {
      return binding('table');
    },
    get RATE_LIMIT_DO() {
      return binding('rate-limit');
    },
    GOOGLE_CLIENT_EMAIL: 'sheetflare-test@example.iam.gserviceaccount.com',
    GOOGLE_PRIVATE_KEY: serviceAccountPrivateKey,
    ADMIN_BEARER_TOKEN: bootstrapToken,
    RATE_LIMIT_MAX_REQUESTS: '300',
    RATE_LIMIT_WINDOW_SECONDS: '60'
  };

  const controlPlaneNamespace = createDurableObjectNamespace<Env>(env, ControlPlaneDO);
  const projectNamespace = createDurableObjectNamespace<Env>(env, ProjectDO);
  const tableNamespace = createDurableObjectNamespace<Env>(env, TableDO);
  const rateLimitNamespace = createDurableObjectNamespace<Env>(env, RateLimitDO);
  bindings['control-plane'] = asBinding(observe('control-plane', controlPlaneNamespace, rpcs));
  bindings.project = asBinding(observe('project', projectNamespace, rpcs));
  bindings.table = asBinding(observe('table', tableNamespace, rpcs));
  bindings['rate-limit'] = asBinding(observe('rate-limit', rateLimitNamespace, rpcs));

  // The gateway reads through `CachedTableReads`, a Workers entrypoint with Workers Cache in front of it. Only the
  // entrypoint is real here: there is no cache emulation, so every read reaches the table Durable Object.
  workerExports.CachedTableReads = Object.assign(
    ({ props }: { props: CachedTableReadProps }) => ({
      fetch: (request: Request) => createCachedTableReadsHarness(env, { props, purgeCalls }).entrypoint.fetch(request)
    }),
    {
      async fetch(): Promise<Response> {
        throw new Error('The gateway reads through CachedTableReads({ props }), never through the bare binding.');
      },
      invalidateProject: (projectSlug: string) =>
        createCachedTableReadsHarness(env, { purgeCalls }).entrypoint.invalidateProject(projectSlug),
      invalidateTable: (projectSlug: string, tableSlug: string) =>
        createCachedTableReadsHarness(env, { purgeCalls }).entrypoint.invalidateTable(projectSlug, tableSlug),
      invalidateRow: (projectSlug: string, tableSlug: string, rowId: string) =>
        createCachedTableReadsHarness(env, { purgeCalls }).entrypoint.invalidateRow(projectSlug, tableSlug, rowId)
    }
  );

  const app = createApp();

  function requestAs(credential: string | null) {
    return async (path: string, requestOptions: RequestOptions = {}) => {
      const headers = new Headers();
      if (credential !== null) {
        headers.set('authorization', `Bearer ${credential}`);
      }
      if (requestOptions.json !== undefined) {
        headers.set('content-type', 'application/json');
      }
      return app.request(
        path,
        {
          method: requestOptions.method ?? 'GET',
          headers,
          ...(requestOptions.json !== undefined ? { body: JSON.stringify(requestOptions.json) } : {})
        },
        env
      );
    };
  }

  // The control plane Durable Object, addressed the way the gateway addresses it but outside the RPC log.
  const controlPlaneStub = controlPlaneNamespace.get(controlPlaneNamespace.idFromName('control-plane'));

  async function expectCreated(response: Response, action: string) {
    if (response.status !== 201) {
      throw new Error(`Expected 201 to ${action} but received ${response.status}: ${await response.text()}`);
    }
  }

  return {
    env,
    bootstrapToken,
    google,
    purgeCalls,
    rpcs,
    rpcsOf: (type) => rpcs.filter((record) => record.body.type === type),
    clearRpcs() {
      rpcs.length = 0;
    },
    requestAs,
    async provision({ slug, rows, tableSlug = 'users', sheetTabName = 'Users', spreadsheetId = `sheet-${slug}` }) {
      google.addSpreadsheet(spreadsheetId, [{ title: sheetTabName, sheetGid: 0, rows }]);
      const asAdmin = requestAs(bootstrapToken);
      await expectCreated(
        await asAdmin('/v1/admin/projects', { method: 'POST', json: { slug, name: slug, spreadsheetId } }),
        `create project ${slug}`
      );
      await expectCreated(
        await asAdmin(`/v1/admin/projects/${slug}/tables`, { method: 'POST', json: { tableSlug, sheetTabName } }),
        `create table ${slug}/${tableSlug}`
      );
    },
    async mintKey(input, credential = bootstrapToken) {
      const response = await requestAs(credential)('/v1/admin/keys', { method: 'POST', json: input });
      await expectCreated(response, `mint key ${input.name}`);
      const created = adminCreateApiKeyResultSchema.parse(await response.json());
      const match = apiKeyPattern.exec(created.apiKey);
      const id = match?.[1];
      const secret = match?.[2];
      if (id === undefined || secret === undefined) {
        throw new Error(`The minted key ${created.record.id} is not shaped like sfk_<id>.<64 hex characters>.`);
      }
      return { credential: created.apiKey, id, secret, record: created.record };
    },
    freshIsolate: __resetGatewayStateForTests,
    controlPlane: {
      rpc: (body) => doRpc<ControlPlaneDoResponse>(controlPlaneStub, body),
      sql: (query, ...parameters) => controlPlaneNamespace.runSql('control-plane', query, ...parameters)
    },
    projectStorage: (projectSlug) => projectNamespace.getStoredTableNames(`project:${projectSlug}`)
  };
}

/** Parses a JSON response body with the contract schema that describes it. */
export async function readJson<TSchema extends z.ZodType>(response: Response, schema: TSchema): Promise<z.infer<TSchema>> {
  return schema.parse(await response.json());
}

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** The `{ code, message }` of an error response. */
export async function readError(response: Response) {
  return (await readJson(response, errorBodySchema)).error;
}
