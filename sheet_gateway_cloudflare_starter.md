# Sheet Gateway Cloudflare Starter

Below is a contiguous starter codebase for a Cloudflare-first, Hono-based, npm workspaces monorepo.

---

## File tree

```text
sheet-gateway/
  package.json
  tsconfig.base.json

  apps/
    api/
      package.json
      tsconfig.json
      wrangler.jsonc
      src/
        env.ts
        index.ts

    admin/
      package.json
      tsconfig.json
      vite.config.ts
      src/
        main.tsx
        app.tsx

  packages/
    contracts/
      package.json
      tsconfig.json
      src/
        index.ts
        ids.ts
        auth.ts
        project.ts
        table.ts
        api.ts
        rpc.ts
        errors.ts

    domain/
      package.json
      tsconfig.json
      src/
        index.ts
        ids.ts
        rows.ts
        pagination.ts

    google-sheets/
      package.json
      tsconfig.json
      src/
        index.ts
        service.ts

    cloudflare/
      package.json
      tsconfig.json
      src/
        index.ts
        rpc.ts
        types.ts
        do/
          project-do.ts
          table-do.ts
          rate-limit-do.ts
```

---

## `/package.json`

```json
{
  "name": "sheet-gateway",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run -ws build",
    "typecheck": "npm run -ws typecheck",
    "dev:api": "npm --workspace @sheet-gateway/api run dev",
    "dev:admin": "npm --workspace @sheet-gateway/admin run dev"
  }
}
```

## `/tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true
  }
}
```

---

# apps/api

## `/apps/api/package.json`

```json
{
  "name": "@sheet-gateway/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build": "wrangler deploy --dry-run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sheet-gateway/cloudflare": "*",
    "@sheet-gateway/contracts": "*",
    "@sheet-gateway/google-sheets": "*",
    "hono": "^4.6.12"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "wrangler": "^4.8.0"
  }
}
```

## `/apps/api/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## `/apps/api/wrangler.jsonc`

```jsonc
{
  "name": "sheet-gateway-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-30",
  "durable_objects": {
    "bindings": [
      { "name": "PROJECT_DO", "class_name": "ProjectDO" },
      { "name": "TABLE_DO", "class_name": "TableDO" },
      { "name": "RATE_LIMIT_DO", "class_name": "RateLimitDO" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["ProjectDO", "TableDO", "RateLimitDO"]
    }
  ],
  "vars": {
    "GOOGLE_CLIENT_EMAIL": "",
    "GOOGLE_PRIVATE_KEY": "",
    "ADMIN_BEARER_TOKEN": ""
  }
}
```

## `/apps/api/src/env.ts`

```ts
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  PROJECT_DO: DurableObjectNamespace;
  TABLE_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;

  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  ADMIN_BEARER_TOKEN?: string;
}
```

## `/apps/api/src/index.ts`

```ts
import { Hono } from 'hono';
import type { Env } from './env';
import type {
  CreateProjectInput,
  CreateRowInput,
  CreateTableInput,
  ProjectDoResponse,
  TableDoResponse,
  UpdateRowInput
} from '@sheet-gateway/contracts';
import { ProjectDO, TableDO, RateLimitDO, doRpc } from '@sheet-gateway/cloudflare';

const app = new Hono<{ Bindings: Env }>();

function getProjectStub(env: Env, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getTableStub(env: Env, projectSlug: string, tableSlug: string) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
}

app.use('*', async (c, next) => {
  const adminToken = c.env.ADMIN_BEARER_TOKEN;
  if (!adminToken) return next();

  const authHeader = c.req.header('authorization');
  if (c.req.path.startsWith('/v1/admin')) {
    if (authHeader !== `Bearer ${adminToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  return next();
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/v1/admin/projects', async (c) => {
  const project = c.req.query('project');
  if (project) {
    const result = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.get',
      projectSlug: project
    });
    return c.json(result);
  }

  // bootstrap list object
  const result = await doRpc<ProjectDoResponse>(getProjectStub(c.env, '__registry__'), {
    type: 'project.list'
  });
  return c.json(result);
});

app.post('/v1/admin/projects', async (c) => {
  const input = await c.req.json<CreateProjectInput>();
  const result = await doRpc<ProjectDoResponse>(getProjectStub(c.env, input.slug), {
    type: 'project.create',
    input
  });
  return c.json(result, 201);
});

app.post('/v1/admin/projects/:project/tables', async (c) => {
  const project = c.req.param('project');
  const input = await c.req.json<CreateTableInput>();

  const result = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
    type: 'project.table.create',
    projectSlug: project,
    input
  });

  return c.json(result, 201);
});

app.get('/v1/projects/:project/tables/:table/rows', async (c) => {
  const project = c.req.param('project');
  const table = c.req.param('table');

  const result = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
    type: 'table.rows.list',
    projectSlug: project,
    tableSlug: table,
    query: {
      limit: Number(c.req.query('limit') ?? 50),
      cursor: c.req.query('cursor') ?? null,
      sort: c.req.query('sort') ?? null
    }
  });

  return c.json(result);
});

app.get('/v1/projects/:project/tables/:table/rows/:id', async (c) => {
  const project = c.req.param('project');
  const table = c.req.param('table');
  const rowId = c.req.param('id');

  const result = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
    type: 'table.row.get',
    projectSlug: project,
    tableSlug: table,
    rowId
  });

  return c.json(result);
});

app.post('/v1/projects/:project/tables/:table/rows', async (c) => {
  const project = c.req.param('project');
  const table = c.req.param('table');
  const input = await c.req.json<CreateRowInput>();

  const result = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
    type: 'table.row.create',
    projectSlug: project,
    tableSlug: table,
    input
  });

  return c.json(result, 201);
});

app.patch('/v1/projects/:project/tables/:table/rows/:id', async (c) => {
  const project = c.req.param('project');
  const table = c.req.param('table');
  const rowId = c.req.param('id');
  const input = await c.req.json<UpdateRowInput>();

  const result = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
    type: 'table.row.update',
    projectSlug: project,
    tableSlug: table,
    rowId,
    input
  });

  return c.json(result);
});

app.delete('/v1/projects/:project/tables/:table/rows/:id', async (c) => {
  const project = c.req.param('project');
  const table = c.req.param('table');
  const rowId = c.req.param('id');

  const result = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
    type: 'table.row.delete',
    projectSlug: project,
    tableSlug: table,
    rowId
  });

  return c.json(result);
});

export { ProjectDO, TableDO, RateLimitDO };
export default app;
```

---

# apps/admin

## `/apps/admin/package.json`

```json
{
  "name": "@sheet-gateway/admin",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.12",
    "@types/react-dom": "^19.0.5",
    "typescript": "^5.8.3",
    "vite": "^6.2.0"
  }
}
```

## `/apps/admin/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

## `/apps/admin/vite.config.ts`

```ts
import { defineConfig } from 'vite';

export default defineConfig({});
```

## `/apps/admin/src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

## `/apps/admin/src/app.tsx`

```tsx
export function App() {
  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Sheet Gateway Admin</h1>
      <p>Starter UI placeholder.</p>
    </main>
  );
}
```

---

# packages/contracts

## `/packages/contracts/package.json`

```json
{
  "name": "@sheet-gateway/contracts",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

## `/packages/contracts/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## `/packages/contracts/src/ids.ts`

```ts
export type ProjectSlug = string;
export type TableSlug = string;
export type ApiKeyId = string;
export type RowId = string;
export type SheetTabName = string;
export type SpreadsheetId = string;
```

## `/packages/contracts/src/auth.ts`

```ts
export type ApiScope =
  | 'project:read'
  | 'project:write'
  | 'table:read'
  | 'table:create'
  | 'table:update'
  | 'table:delete'
  | 'admin:keys'
  | 'admin:logs';

export interface ApiKeyRecord {
  id: string;
  projectSlug: string;
  name: string;
  hash: string;
  scopes: ApiScope[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}
```

## `/packages/contracts/src/project.ts`

```ts
import type { ProjectSlug, SpreadsheetId, TableSlug } from './ids';

export interface ProjectConfig {
  slug: ProjectSlug;
  name: string;
  spreadsheetId: SpreadsheetId;
  googleCredentialRef: string;
  createdAt: string;
  updatedAt: string;
  defaultAuthMode: 'private' | 'public-read';
}

export interface TableConfig {
  projectSlug: ProjectSlug;
  tableSlug: TableSlug;
  sheetTabName: string;
  sheetGid?: number;
  idColumn: string;
  headerRow: number;
  dataStartRow: number;
  readEnabled: boolean;
  createEnabled: boolean;
  updateEnabled: boolean;
  deleteEnabled: boolean;
  cacheTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
}
```

## `/packages/contracts/src/table.ts`

```ts
import type { RowId } from './ids';

export type RowValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | boolean[];

export type RowRecord = Record<string, RowValue>;

export interface RowEnvelope {
  id: RowId;
  rowNumber: number;
  values: RowRecord;
}

export interface TableSchemaField {
  name: string;
  inferredType: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'unknown';
  nullable: boolean;
}

export interface TableSchema {
  fields: TableSchemaField[];
  inferredAt: string;
}

export interface ListRowsQuery {
  limit?: number;
  cursor?: string | null;
  sort?: string | null;
  fields?: string[] | null;
  filter?: Record<string, unknown> | null;
}

export interface ListRowsResult {
  data: RowEnvelope[];
  nextCursor: string | null;
}
```

## `/packages/contracts/src/api.ts`

```ts
import type { ProjectConfig, TableConfig } from './project';
import type { ListRowsQuery, ListRowsResult, RowEnvelope, RowRecord, TableSchema } from './table';

export interface CreateProjectInput {
  slug: string;
  name: string;
  spreadsheetId: string;
  googleCredentialRef: string;
  defaultAuthMode?: 'private' | 'public-read';
}

export interface CreateTableInput {
  tableSlug: string;
  sheetTabName: string;
  sheetGid?: number;
  idColumn?: string;
  headerRow?: number;
  dataStartRow?: number;
  readEnabled?: boolean;
  createEnabled?: boolean;
  updateEnabled?: boolean;
  deleteEnabled?: boolean;
  cacheTtlSeconds?: number;
}

export interface CreateRowInput {
  values: RowRecord;
}

export interface UpdateRowInput {
  values: Partial<RowRecord>;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  spreadsheetId: string;
  tableCount: number;
  updatedAt: string;
}

export interface AdminListProjectsResult {
  data: ProjectSummary[];
}

export interface AdminGetProjectResult {
  project: ProjectConfig;
  tables: TableConfig[];
}

export interface GetRowResult {
  data: RowEnvelope;
}

export interface CreateRowResult {
  data: RowEnvelope;
  ignoredKeys: string[];
}

export interface UpdateRowResult {
  data: RowEnvelope;
  ignoredKeys: string[];
}

export interface DeleteRowResult {
  ok: true;
  deletedId: string;
}

export interface GetSchemaResult {
  data: TableSchema;
}

export type {
  ListRowsQuery,
  ListRowsResult,
  ProjectConfig,
  TableConfig
};
```

## `/packages/contracts/src/rpc.ts`

```ts
import type {
  CreateProjectInput,
  CreateTableInput,
  CreateRowInput,
  UpdateRowInput,
  AdminGetProjectResult,
  AdminListProjectsResult,
  GetRowResult,
  CreateRowResult,
  UpdateRowResult,
  DeleteRowResult,
  GetSchemaResult,
  ListRowsQuery,
  ListRowsResult
} from './api';
import type { TableConfig } from './project';

export type ProjectDoRequest =
  | { type: 'project.get'; projectSlug: string }
  | { type: 'project.create'; input: CreateProjectInput }
  | { type: 'project.list' }
  | { type: 'project.table.create'; projectSlug: string; input: CreateTableInput }
  | { type: 'project.table.list'; projectSlug: string }
  | { type: 'project.table.get'; projectSlug: string; tableSlug: string };

export type ProjectDoResponse =
  | { type: 'project.get.result'; result: AdminGetProjectResult }
  | { type: 'project.create.result'; result: AdminGetProjectResult }
  | { type: 'project.list.result'; result: AdminListProjectsResult }
  | { type: 'project.table.create.result'; result: TableConfig }
  | { type: 'project.table.list.result'; result: TableConfig[] }
  | { type: 'project.table.get.result'; result: TableConfig };

export type TableDoRequest =
  | { type: 'table.rows.list'; projectSlug: string; tableSlug: string; query: ListRowsQuery }
  | { type: 'table.row.get'; projectSlug: string; tableSlug: string; rowId: string }
  | { type: 'table.row.create'; projectSlug: string; tableSlug: string; input: CreateRowInput }
  | { type: 'table.row.update'; projectSlug: string; tableSlug: string; rowId: string; input: UpdateRowInput }
  | { type: 'table.row.delete'; projectSlug: string; tableSlug: string; rowId: string }
  | { type: 'table.schema.get'; projectSlug: string; tableSlug: string }
  | { type: 'table.reindex'; projectSlug: string; tableSlug: string };

export type TableDoResponse =
  | { type: 'table.rows.list.result'; result: ListRowsResult }
  | { type: 'table.row.get.result'; result: GetRowResult }
  | { type: 'table.row.create.result'; result: CreateRowResult }
  | { type: 'table.row.update.result'; result: UpdateRowResult }
  | { type: 'table.row.delete.result'; result: DeleteRowResult }
  | { type: 'table.schema.get.result'; result: GetSchemaResult }
  | { type: 'table.reindex.result'; result: { ok: true; rowCount: number } };
```

## `/packages/contracts/src/errors.ts`

```ts
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'FORBIDDEN', 403, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'BAD_REQUEST', 400, details);
  }
}
```

## `/packages/contracts/src/index.ts`

```ts
export * from './ids';
export * from './auth';
export * from './project';
export * from './table';
export * from './api';
export * from './rpc';
export * from './errors';
```

---

# packages/domain

## `/packages/domain/package.json`

```json
{
  "name": "@sheet-gateway/domain",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sheet-gateway/contracts": "*"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

## `/packages/domain/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## `/packages/domain/src/ids.ts`

```ts
export function generateRowId(): string {
  return crypto.randomUUID();
}
```

## `/packages/domain/src/rows.ts`

```ts
import type { RowRecord } from '@sheet-gateway/contracts';

export function normalizeRowValues(input: RowRecord): RowRecord {
  const out: RowRecord = {};

  for (const [key, value] of Object.entries(input)) {
    out[key.trim()] = value;
  }

  return out;
}

export function pickKnownColumns(
  values: RowRecord,
  headers: string[]
): { values: RowRecord; ignoredKeys: string[] } {
  const allowed = new Set(headers);
  const next: RowRecord = {};
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) next[key] = value;
    else ignoredKeys.push(key);
  }

  return { values: next, ignoredKeys };
}
```

## `/packages/domain/src/pagination.ts`

```ts
import type { ListRowsQuery } from '@sheet-gateway/contracts';

export function normalizeListQuery(query: ListRowsQuery): Required<ListRowsQuery> {
  return {
    limit: Math.min(Math.max(query.limit ?? 50, 1), 500),
    cursor: query.cursor ?? null,
    sort: query.sort ?? null,
    fields: query.fields ?? null,
    filter: query.filter ?? null
  };
}
```

## `/packages/domain/src/index.ts`

```ts
export * from './ids';
export * from './rows';
export * from './pagination';
```

---

# packages/google-sheets

## `/packages/google-sheets/package.json`

```json
{
  "name": "@sheet-gateway/google-sheets",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sheet-gateway/contracts": "*"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

## `/packages/google-sheets/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## `/packages/google-sheets/src/service.ts`

```ts
import type { RowEnvelope, RowRecord, TableConfig } from '@sheet-gateway/contracts';

export interface GoogleServiceAccountConfig {
  clientEmail: string;
  privateKey: string;
}

export class GoogleSheetsService {
  constructor(private readonly _config: GoogleServiceAccountConfig) {}

  async readHeaders(config: TableConfig): Promise<string[]> {
    void config;
    return [config.idColumn, 'name', 'email'];
  }

  async readAllRows(config: TableConfig): Promise<RowEnvelope[]> {
    void config;
    return [];
  }

  async readSingleRow(config: TableConfig, rowNumber: number): Promise<RowEnvelope> {
    void config;
    return {
      id: 'placeholder',
      rowNumber,
      values: {}
    };
  }

  async appendRow(config: TableConfig, headers: string[], values: RowRecord): Promise<number> {
    void config;
    void headers;
    void values;
    return 2;
  }

  async writeRow(config: TableConfig, rowNumber: number, headers: string[], values: RowRecord): Promise<void> {
    void config;
    void rowNumber;
    void headers;
    void values;
  }

  async deleteRow(config: TableConfig, rowNumber: number): Promise<void> {
    void config;
    void rowNumber;
  }
}
```

## `/packages/google-sheets/src/index.ts`

```ts
export * from './service';
```

---

# packages/cloudflare

## `/packages/cloudflare/package.json`

```json
{
  "name": "@sheet-gateway/cloudflare",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sheet-gateway/contracts": "*",
    "@sheet-gateway/domain": "*",
    "@sheet-gateway/google-sheets": "*"
  },
  "devDependencies": {
    "typescript": "^5.8.3"
  }
}
```

## `/packages/cloudflare/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## `/packages/cloudflare/src/types.ts`

```ts
import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export interface CloudflareEnv {
  PROJECT_DO: DurableObjectNamespace;
  TABLE_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  ADMIN_BEARER_TOKEN?: string;
}
```

## `/packages/cloudflare/src/rpc.ts`

```ts
export async function doRpc<TResponse>(
  stub: DurableObjectStub,
  body: unknown
): Promise<TResponse> {
  const res = await stub.fetch('https://do.internal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Durable Object RPC failed: ${res.status} ${text}`);
  }

  return await res.json<TResponse>();
}
```

## `/packages/cloudflare/src/do/project-do.ts`

```ts
import type {
  AdminGetProjectResult,
  AdminListProjectsResult,
  CreateProjectInput,
  CreateTableInput,
  ProjectConfig,
  ProjectDoRequest,
  ProjectDoResponse,
  TableConfig
} from '@sheet-gateway/contracts';

interface ProjectRow {
  slug: string;
  name: string;
  spreadsheet_id: string;
  google_credential_ref: string;
  default_auth_mode: string;
  created_at: string;
  updated_at: string;
}

interface TableRow {
  project_slug: string;
  table_slug: string;
  sheet_tab_name: string;
  sheet_gid: number | null;
  id_column: string;
  header_row: number;
  data_start_row: number;
  read_enabled: number;
  create_enabled: number;
  update_enabled: number;
  delete_enabled: number;
  cache_ttl_seconds: number;
  created_at: string;
  updated_at: string;
}

export class ProjectDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.init();
  }

  private init() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        google_credential_ref TEXT NOT NULL,
        default_auth_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        project_slug TEXT NOT NULL,
        table_slug TEXT NOT NULL,
        sheet_tab_name TEXT NOT NULL,
        sheet_gid INTEGER,
        id_column TEXT NOT NULL,
        header_row INTEGER NOT NULL,
        data_start_row INTEGER NOT NULL,
        read_enabled INTEGER NOT NULL,
        create_enabled INTEGER NOT NULL,
        update_enabled INTEGER NOT NULL,
        delete_enabled INTEGER NOT NULL,
        cache_ttl_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_slug, table_slug)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spreadsheet_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        table_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await req.json()) as ProjectDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
  }

  private async handle(body: ProjectDoRequest): Promise<ProjectDoResponse> {
    switch (body.type) {
      case 'project.create':
        return { type: 'project.create.result', result: await this.createProject(body.input) };
      case 'project.get':
        return { type: 'project.get.result', result: await this.getProject(body.projectSlug) };
      case 'project.list':
        return { type: 'project.list.result', result: await this.listProjects() };
      case 'project.table.create':
        return {
          type: 'project.table.create.result',
          result: await this.createTable(body.projectSlug, body.input)
        };
      case 'project.table.list':
        return {
          type: 'project.table.list.result',
          result: await this.listTables(body.projectSlug)
        };
      case 'project.table.get':
        return {
          type: 'project.table.get.result',
          result: await this.getTable(body.projectSlug, body.tableSlug)
        };
    }
  }

  private async createProject(input: CreateProjectInput): Promise<AdminGetProjectResult> {
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `
      INSERT INTO project (
        slug, name, spreadsheet_id, google_credential_ref,
        default_auth_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        spreadsheet_id = excluded.spreadsheet_id,
        google_credential_ref = excluded.google_credential_ref,
        default_auth_mode = excluded.default_auth_mode,
        updated_at = excluded.updated_at
      `,
      input.slug,
      input.name,
      input.spreadsheetId,
      input.googleCredentialRef,
      input.defaultAuthMode ?? 'private',
      now,
      now
    );

    this.ctx.storage.sql.exec(
      `
      INSERT INTO project_registry (slug, name, spreadsheet_id, updated_at, table_count)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        spreadsheet_id = excluded.spreadsheet_id,
        updated_at = excluded.updated_at
      `,
      input.slug,
      input.name,
      input.spreadsheetId,
      now
    );

    return this.getProject(input.slug);
  }

  private async getProject(projectSlug: string): Promise<AdminGetProjectResult> {
    const project = this.ctx.storage.sql
      .exec(`SELECT * FROM project WHERE slug = ?`, projectSlug)
      .one() as ProjectRow | null;

    if (!project) throw new Error(`Project not found: ${projectSlug}`);

    return {
      project: this.mapProject(project),
      tables: await this.listTables(projectSlug)
    };
  }

  private async listProjects(): Promise<AdminListProjectsResult> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT slug, name, spreadsheet_id, table_count, updated_at FROM project_registry ORDER BY updated_at DESC`
    ).toArray() as Array<{
      slug: string;
      name: string;
      spreadsheet_id: string;
      table_count: number;
      updated_at: string;
    }>;

    return {
      data: rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        spreadsheetId: row.spreadsheet_id,
        tableCount: row.table_count,
        updatedAt: row.updated_at
      }))
    };
  }

  private async createTable(projectSlug: string, input: CreateTableInput): Promise<TableConfig> {
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `
      INSERT INTO tables (
        project_slug, table_slug, sheet_tab_name, sheet_gid, id_column,
        header_row, data_start_row, read_enabled, create_enabled, update_enabled,
        delete_enabled, cache_ttl_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_slug, table_slug) DO UPDATE SET
        sheet_tab_name = excluded.sheet_tab_name,
        sheet_gid = excluded.sheet_gid,
        id_column = excluded.id_column,
        header_row = excluded.header_row,
        data_start_row = excluded.data_start_row,
        read_enabled = excluded.read_enabled,
        create_enabled = excluded.create_enabled,
        update_enabled = excluded.update_enabled,
        delete_enabled = excluded.delete_enabled,
        cache_ttl_seconds = excluded.cache_ttl_seconds,
        updated_at = excluded.updated_at
      `,
      projectSlug,
      input.tableSlug,
      input.sheetTabName,
      input.sheetGid ?? null,
      input.idColumn ?? '_id',
      input.headerRow ?? 1,
      input.dataStartRow ?? 2,
      (input.readEnabled ?? true) ? 1 : 0,
      (input.createEnabled ?? true) ? 1 : 0,
      (input.updateEnabled ?? true) ? 1 : 0,
      (input.deleteEnabled ?? true) ? 1 : 0,
      input.cacheTtlSeconds ?? 15,
      now,
      now
    );

    const countRow = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS count FROM tables WHERE project_slug = ?`, projectSlug)
      .one() as { count: number } | null;

    this.ctx.storage.sql.exec(
      `UPDATE project_registry SET table_count = ?, updated_at = ? WHERE slug = ?`,
      countRow?.count ?? 0,
      now,
      projectSlug
    );

    return this.getTable(projectSlug, input.tableSlug);
  }

  private async getTable(projectSlug: string, tableSlug: string): Promise<TableConfig> {
    const row = this.ctx.storage.sql
      .exec(`SELECT * FROM tables WHERE project_slug = ? AND table_slug = ?`, projectSlug, tableSlug)
      .one() as TableRow | null;

    if (!row) throw new Error(`Table not found: ${projectSlug}/${tableSlug}`);
    return this.mapTable(row);
  }

  private async listTables(projectSlug: string): Promise<TableConfig[]> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM tables WHERE project_slug = ? ORDER BY table_slug ASC`, projectSlug)
      .toArray() as TableRow[];

    return rows.map((row) => this.mapTable(row));
  }

  private mapProject(row: ProjectRow): ProjectConfig {
    return {
      slug: row.slug,
      name: row.name,
      spreadsheetId: row.spreadsheet_id,
      googleCredentialRef: row.google_credential_ref,
      defaultAuthMode: row.default_auth_mode as 'private' | 'public-read',
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private mapTable(row: TableRow): TableConfig {
    return {
      projectSlug: row.project_slug,
      tableSlug: row.table_slug,
      sheetTabName: row.sheet_tab_name,
      sheetGid: row.sheet_gid ?? undefined,
      idColumn: row.id_column,
      headerRow: row.header_row,
      dataStartRow: row.data_start_row,
      readEnabled: !!row.read_enabled,
      createEnabled: !!row.create_enabled,
      updateEnabled: !!row.update_enabled,
      deleteEnabled: !!row.delete_enabled,
      cacheTtlSeconds: row.cache_ttl_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
```

## `/packages/cloudflare/src/do/table-do.ts`

```ts
import type {
  RowEnvelope,
  RowRecord,
  TableConfig,
  TableDoRequest,
  TableDoResponse
} from '@sheet-gateway/contracts';
import { generateRowId, normalizeListQuery, normalizeRowValues, pickKnownColumns } from '@sheet-gateway/domain';
import { GoogleSheetsService } from '@sheet-gateway/google-sheets';
import type { CloudflareEnv } from '../types';

type TableMetaRow = {
  key: string;
  value: string;
};

export class TableDO extends DurableObject {
  private sheets: GoogleSheetsService;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.sheets = new GoogleSheetsService({
      clientEmail: env.GOOGLE_CLIENT_EMAIL,
      privateKey: env.GOOGLE_PRIVATE_KEY
    });
    this.init();
  }

  private init() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS row_index (
        row_id TEXT PRIMARY KEY,
        row_number INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_row_index_row_number
      ON row_index(row_number)
    `);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await req.json()) as TableDoRequest;
    const result = await this.handle(body);
    return Response.json(result);
  }

  private async handle(body: TableDoRequest): Promise<TableDoResponse> {
    switch (body.type) {
      case 'table.rows.list':
        return {
          type: 'table.rows.list.result',
          result: await this.listRows(body.projectSlug, body.tableSlug, body.query)
        };
      case 'table.row.get':
        return {
          type: 'table.row.get.result',
          result: await this.getRow(body.projectSlug, body.tableSlug, body.rowId)
        };
      case 'table.row.create':
        return {
          type: 'table.row.create.result',
          result: await this.createRow(body.projectSlug, body.tableSlug, body.input.values)
        };
      case 'table.row.update':
        return {
          type: 'table.row.update.result',
          result: await this.updateRow(body.projectSlug, body.tableSlug, body.rowId, body.input.values)
        };
      case 'table.row.delete':
        return {
          type: 'table.row.delete.result',
          result: await this.deleteRow(body.projectSlug, body.tableSlug, body.rowId)
        };
      case 'table.schema.get':
        return {
          type: 'table.schema.get.result',
          result: await this.getSchema(body.projectSlug, body.tableSlug)
        };
      case 'table.reindex':
        return {
          type: 'table.reindex.result',
          result: await this.reindex(body.projectSlug, body.tableSlug)
        };
    }
  }

  private async getTableConfig(projectSlug: string, tableSlug: string): Promise<TableConfig> {
    const stub = this.env.PROJECT_DO.get(this.env.PROJECT_DO.idFromName(`project:${projectSlug}`));
    const res = await stub.fetch('https://do.internal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'project.table.get',
        projectSlug,
        tableSlug
      })
    });

    if (!res.ok) throw new Error('Failed to load table config');
    const data = await res.json<{ type: 'project.table.get.result'; result: TableConfig }>();
    return data.result;
  }

  private async listRows(projectSlug: string, tableSlug: string, rawQuery: any) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const query = normalizeListQuery(rawQuery);
    const rows = await this.sheets.readAllRows(config);

    return {
      data: rows.slice(0, query.limit),
      nextCursor: rows.length > query.limit ? String(query.limit) : null
    };
  }

  private async getRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);

    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }
    if (!rowNumber) throw new Error(`Row not found: ${rowId}`);

    return { data: await this.sheets.readSingleRow(config, rowNumber) };
  }

  private async createRow(projectSlug: string, tableSlug: string, input: RowRecord) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const headers = await this.getHeaders(config);

    const rowId = typeof input[config.idColumn] === 'string'
      ? String(input[config.idColumn])
      : generateRowId();

    const normalized = normalizeRowValues({
      ...input,
      [config.idColumn]: rowId
    });

    const { values, ignoredKeys } = pickKnownColumns(normalized, headers);
    const rowNumber = await this.sheets.appendRow(config, headers, values);

    this.upsertRowIndex(rowId, rowNumber);

    return {
      data: {
        id: rowId,
        rowNumber,
        values
      },
      ignoredKeys
    };
  }

  private async updateRow(projectSlug: string, tableSlug: string, rowId: string, patch: Partial<RowRecord>) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const headers = await this.getHeaders(config);

    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }
    if (!rowNumber) throw new Error(`Row not found: ${rowId}`);

    const current = await this.sheets.readSingleRow(config, rowNumber);
    const merged = normalizeRowValues({
      ...current.values,
      ...patch,
      [config.idColumn]: rowId
    });

    const { values, ignoredKeys } = pickKnownColumns(merged, headers);
    await this.sheets.writeRow(config, rowNumber, headers, values);

    return {
      data: { id: rowId, rowNumber, values },
      ignoredKeys
    };
  }

  private async deleteRow(projectSlug: string, tableSlug: string, rowId: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);

    let rowNumber = this.lookupRowNumber(rowId);
    if (!rowNumber) {
      await this.reindex(projectSlug, tableSlug);
      rowNumber = this.lookupRowNumber(rowId);
    }
    if (!rowNumber) throw new Error(`Row not found: ${rowId}`);

    await this.sheets.deleteRow(config, rowNumber);
    this.deleteRowIndex(rowId);
    await this.reindex(projectSlug, tableSlug);

    return {
      ok: true as const,
      deletedId: rowId
    };
  }

  private async getSchema(projectSlug: string, tableSlug: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const rows = await this.sheets.readAllRows(config);
    const fieldNames = new Set<string>();

    for (const row of rows.slice(0, 100)) {
      for (const key of Object.keys(row.values)) fieldNames.add(key);
    }

    return {
      data: {
        fields: [...fieldNames].map((name) => ({
          name,
          inferredType: 'unknown' as const,
          nullable: true
        })),
        inferredAt: new Date().toISOString()
      }
    };
  }

  private async reindex(projectSlug: string, tableSlug: string) {
    const config = await this.getTableConfig(projectSlug, tableSlug);
    const rows = await this.sheets.readAllRows(config);

    this.ctx.storage.sql.exec(`DELETE FROM row_index`);

    for (const row of rows) {
      this.upsertRowIndex(row.id, row.rowNumber);
    }

    return {
      ok: true as const,
      rowCount: rows.length
    };
  }

  private lookupRowNumber(rowId: string): number | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT row_number FROM row_index WHERE row_id = ?`, rowId)
      .one() as { row_number: number } | null;

    return row?.row_number ?? null;
  }

  private upsertRowIndex(rowId: string, rowNumber: number) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO row_index (row_id, row_number, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(row_id) DO UPDATE SET
        row_number = excluded.row_number,
        updated_at = excluded.updated_at
      `,
      rowId,
      rowNumber,
      new Date().toISOString()
    );
  }

  private deleteRowIndex(rowId: string) {
    this.ctx.storage.sql.exec(`DELETE FROM row_index WHERE row_id = ?`, rowId);
  }

  private async getHeaders(config: TableConfig): Promise<string[]> {
    const cached = this.getMeta('headers');
    if (cached) return JSON.parse(cached) as string[];

    const headers = await this.sheets.readHeaders(config);
    this.setMeta('headers', JSON.stringify(headers));
    return headers;
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec(`SELECT key, value FROM meta WHERE key = ?`, key)
      .one() as TableMetaRow | null;

    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      `
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      key,
      value
    );
  }
}
```

## `/packages/cloudflare/src/do/rate-limit-do.ts`

```ts
export class RateLimitDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(_req: Request): Promise<Response> {
    return Response.json({ ok: true });
  }
}
```

## `/packages/cloudflare/src/index.ts`

```ts
export * from './rpc';
export * from './types';
export * from './do/project-do';
export * from './do/table-do';
export * from './do/rate-limit-do';
```

---

# First run notes

## 1. Install

```bash
npm install
```

## 2. Start API locally

```bash
npm run dev:api
```

## 3. Start admin locally

```bash
npm run dev:admin
```

## 4. What is still placeholder

The biggest incomplete piece is `GoogleSheetsService`.

That service still needs real implementation for:

- service-account auth
- reading header rows from Google Sheets
- reading all rows for a tab
- reading a single row by row number
- appending a row
- writing a row
- deleting a row via batch update

Once that is wired in, the rest of the skeleton is enough to exercise the basic architecture.

---

# Recommended next steps

1. Replace `GoogleSheetsService` placeholders with the real Sheets API calls.
2. Add Zod validation at the Hono route boundary.
3. Replace the quick admin bearer token with scoped API keys.
4. Add a dedicated registry object or D1 later if you want richer global admin views.
5. Flesh out the admin UI for projects, tables, schema preview, and generated snippets.

---

# Important caveat

The project listing approach here uses a `project_registry` table stored inside whichever `ProjectDO` gets hit for `project.list`. That is good enough as a starter sketch, but for a real implementation you should probably introduce either:

- a dedicated `RegistryDO`, or
- D1 for global control-plane listing/reporting

Everything else in this starter is still valid if you make that refinement.

