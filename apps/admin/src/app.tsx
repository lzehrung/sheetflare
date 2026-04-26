import { useEffect, useState } from 'react';
import type { ApiScope, ProjectSummary, TableConfig } from '@sheetflare/contracts';
import {
  normalizeAdminCredential,
  readStoredAdminCredential,
  writeStoredAdminCredential
} from './auth';
import {
  createApiKey,
  createProject,
  createTable,
  getCacheStatus,
  getProject,
  listProjects,
  reindexTable
} from './api';
import './styles.css';

type LoadState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ProjectSummary[] }
  | { status: 'error'; message: string; unauthorized: boolean };

type ProjectDetailState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; tables: TableConfig[] }
  | { status: 'error'; message: string };

type CacheStateByTable = Record<string, { status: string; staleReason: string; rowCount: number } | null>;

const allScopes: ApiScope[] = [
  'admin:projects',
  'admin:keys',
  'table:read',
  'table:create',
  'table:update',
  'table:delete'
];

function getInitialCredential() {
  if (typeof window === 'undefined') {
    return null;
  }

  return readStoredAdminCredential(window.localStorage);
}

export function App() {
  const storedCredential = getInitialCredential();
  const [credential, setCredential] = useState<string | null>(() => storedCredential);
  const [draftCredential, setDraftCredential] = useState<string>(() => storedCredential ?? '');
  const [rememberCredential, setRememberCredential] = useState<boolean>(() => Boolean(storedCredential));
  const [state, setState] = useState<LoadState>(() =>
    storedCredential
      ? { status: 'loading' }
      : {
          status: 'idle',
          message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
        }
  );
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null);
  const [projectDetailState, setProjectDetailState] = useState<ProjectDetailState>({
    status: 'idle',
    message: 'Select a project to inspect tables, cache state, and keys.'
  });
  const [cacheStateByTable, setCacheStateByTable] = useState<CacheStateByTable>({});
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createProjectDraft, setCreateProjectDraft] = useState<CreateProjectDraft>({
    slug: '',
    name: '',
    spreadsheetId: '',
    defaultAuthMode: 'private'
  });
  const [createTableDraft, setCreateTableDraft] = useState<CreateTableDraft>({
    tableSlug: '',
    sheetTabName: '',
    idColumn: '_id',
    indexedFields: 'name,status',
    cacheTtlSeconds: '15'
  });
  const [createKeyDraft, setCreateKeyDraft] = useState<CreateKeyDraft>({
    name: 'ops-key',
    projectScoped: true,
    scopes: ['admin:projects', 'admin:keys', 'table:read']
  });

  useEffect(() => {
    if (!credential) {
      setState({
        status: 'idle',
        message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const body = await listProjects(credential);
        if (!cancelled) {
          setState({ status: 'ready', data: body.data });
          if (body.data.length > 0) {
            setSelectedProjectSlug((current) => current ?? body.data[0]!.slug);
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          setState({
            status: 'error',
            message,
            unauthorized: message.includes('rejected')
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [credential]);

  useEffect(() => {
    if (!credential || !selectedProjectSlug) {
      setProjectDetailState({
        status: 'idle',
        message: 'Select a project to inspect tables, cache state, and keys.'
      });
      return;
    }

    let cancelled = false;
    setProjectDetailState({ status: 'loading' });

    void (async () => {
      try {
        const detail = await getProject(credential, selectedProjectSlug);
        if (!cancelled) {
          setProjectDetailState({
            status: 'ready',
            tables: detail.tables
          });
        }
      } catch (error) {
        if (!cancelled) {
          setProjectDetailState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [credential, selectedProjectSlug]);

  function saveCredential() {
    const normalized = normalizeAdminCredential(draftCredential);
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, rememberCredential ? normalized : null);
    }

    setCredential(normalized);
    setDraftCredential(normalized ?? '');
  }

  function clearCredential() {
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, null);
    }

    setCredential(null);
    setDraftCredential('');
    setRememberCredential(false);
    setSelectedProjectSlug(null);
    setProjectDetailState({
      status: 'idle',
      message: 'Select a project to inspect tables, cache state, and keys.'
    });
  }

  async function refreshProjects() {
    if (!credential) return;
    setState({ status: 'loading' });
    try {
      const body = await listProjects(credential);
      setState({ status: 'ready', data: body.data });
      if (body.data.length > 0) {
        setSelectedProjectSlug((current) => current ?? body.data[0]!.slug);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setState({
        status: 'error',
        message,
        unauthorized: message.includes('rejected')
      });
    }
  }

  async function handleCreateProject() {
    if (!credential) return;
    const input = {
      slug: createProjectDraft.slug.trim(),
      name: createProjectDraft.name.trim(),
      spreadsheetId: createProjectDraft.spreadsheetId.trim(),
      defaultAuthMode: createProjectDraft.defaultAuthMode
    };
    await createProject(credential, input);
    setCreateProjectDraft({
      slug: '',
      name: '',
      spreadsheetId: '',
      defaultAuthMode: 'private'
    });
    await refreshProjects();
    setSelectedProjectSlug(input.slug);
  }

  async function handleCreateTable() {
    if (!credential || !selectedProjectSlug) return;
    await createTable(credential, selectedProjectSlug, {
      tableSlug: createTableDraft.tableSlug.trim(),
      sheetTabName: createTableDraft.sheetTabName.trim(),
      idColumn: createTableDraft.idColumn.trim(),
      indexedFields: createTableDraft.indexedFields
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      cacheTtlSeconds: Number(createTableDraft.cacheTtlSeconds)
    });
    setCreateTableDraft({
      tableSlug: '',
      sheetTabName: '',
      idColumn: '_id',
      indexedFields: 'name,status',
      cacheTtlSeconds: '15'
    });
    const detail = await getProject(credential, selectedProjectSlug);
    setProjectDetailState({
      status: 'ready',
      tables: detail.tables
    });
  }

  async function handleCreateKey() {
    if (!credential) return;
    const response = await createApiKey(credential, {
      name: createKeyDraft.name.trim(),
      projectSlug: createKeyDraft.projectScoped ? selectedProjectSlug : null,
      scopes: createKeyDraft.scopes
    });
    setCreatedKey(response.apiKey);
  }

  async function handleLoadCache(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    const response = await getCacheStatus(credential, selectedProjectSlug, tableSlug);
    setCacheStateByTable((current) => ({
      ...current,
      [tableSlug]: {
        status: response.data.status,
        staleReason: response.data.staleReason,
        rowCount: response.data.rowCount
      }
    }));
  }

  async function handleReindex(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    const response = await reindexTable(credential, selectedProjectSlug, tableSlug);
    setCacheStateByTable((current) => ({
      ...current,
      [tableSlug]: {
        status: response.cache.status,
        staleReason: response.cache.staleReason,
        rowCount: response.rowCount
      }
    }));
  }

  const projectCount = state.status === 'ready' ? state.data.length : '...';

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloudflare Durable Objects + Google Sheets</p>
        <h1>Sheetflare Admin</h1>
        <p className="lede">
          A starter control plane for treating spreadsheet tabs like lightweight JSON tables.
        </p>
      </section>

      <section className="panel authPanel">
        <div className="panelHeader">
          <div>
            <h2>Operator Access</h2>
            <p className="muted compact">
              Use a bootstrap admin token or a scoped admin API key. The credential is stored locally in this browser.
            </p>
          </div>
          <span className="badge">{credential ? 'Configured' : 'Required'}</span>
        </div>

        <label className="field">
          <span>Admin credential</span>
          <input
            type="password"
            value={draftCredential}
            onChange={(event) => setDraftCredential(event.target.value)}
            placeholder="sfk_... or bootstrap token"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={rememberCredential}
            onChange={(event) => setRememberCredential(event.target.checked)}
          />
          <span>Remember this credential in this browser</span>
        </label>

        <div className="actions">
          <button type="button" onClick={saveCredential}>
            Save and load
          </button>
          <button type="button" className="secondaryButton" onClick={clearCredential}>
            Clear
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Projects</h2>
          <span className="badge">{projectCount}</span>
        </div>

        {state.status === 'idle' ? <p className="muted">{state.message}</p> : null}
        {state.status === 'loading' ? <p className="muted">Loading project registry...</p> : null}
        {state.status === 'error' ? (
          <p className="error">
            {state.message}
            {state.unauthorized ? ' Update the stored credential and try again.' : ''}
          </p>
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <p className="muted">No projects yet. Create one through the admin API to get started.</p>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <div className="cards">
            {state.data.map((project) => (
              <article
                key={project.slug}
                className={`card selectableCard${selectedProjectSlug === project.slug ? ' selectedCard' : ''}`}
                onClick={() => setSelectedProjectSlug(project.slug)}
              >
                <div className="cardTop">
                  <div>
                    <p className="slug">{project.slug}</p>
                    <h3>{project.name}</h3>
                  </div>
                  <span className="badge">{project.tableCount} tables</span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>Spreadsheet</dt>
                    <dd>{project.spreadsheetId}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel splitPanel">
        <div>
          <div className="panelHeader">
            <h2>Create Project</h2>
          </div>
          <div className="stack">
            <label className="field">
              <span>Slug</span>
              <input value={createProjectDraft.slug} onChange={(event) => setCreateProjectDraft((current) => ({ ...current, slug: event.target.value }))} />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={createProjectDraft.name} onChange={(event) => setCreateProjectDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="field">
              <span>Spreadsheet ID</span>
              <input value={createProjectDraft.spreadsheetId} onChange={(event) => setCreateProjectDraft((current) => ({ ...current, spreadsheetId: event.target.value }))} />
            </label>
            <label className="field">
              <span>Default Auth Mode</span>
              <select value={createProjectDraft.defaultAuthMode} onChange={(event) => setCreateProjectDraft((current) => ({ ...current, defaultAuthMode: event.target.value as 'private' | 'public-read' }))}>
                <option value="private">private</option>
                <option value="public-read">public-read</option>
              </select>
            </label>
            <div className="actions">
              <button type="button" onClick={() => void handleCreateProject()} disabled={!credential}>
                Save project
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="panelHeader">
            <h2>Create API Key</h2>
          </div>
          <div className="stack">
            <label className="field">
              <span>Name</span>
              <input value={createKeyDraft.name} onChange={(event) => setCreateKeyDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={createKeyDraft.projectScoped}
                onChange={(event) => setCreateKeyDraft((current) => ({ ...current, projectScoped: event.target.checked }))}
              />
              <span>Scope this key to the selected project</span>
            </label>
            <div className="scopeGrid">
              {allScopes.map((scope) => (
                <label key={scope} className="toggle">
                  <input
                    type="checkbox"
                    checked={createKeyDraft.scopes.includes(scope)}
                    onChange={(event) => {
                      setCreateKeyDraft((current) => ({
                        ...current,
                        scopes: event.target.checked
                          ? [...current.scopes, scope]
                          : current.scopes.filter((entry) => entry !== scope)
                      }));
                    }}
                  />
                  <span>{scope}</span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button type="button" onClick={() => void handleCreateKey()} disabled={!credential || createKeyDraft.scopes.length === 0}>
                Create key
              </button>
            </div>
            {createdKey ? <p className="success">New key: <code>{createdKey}</code></p> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Selected Project</h2>
            <p className="muted compact">{selectedProjectSlug ?? 'No project selected'}</p>
          </div>
        </div>

        {projectDetailState.status === 'idle' ? <p className="muted">{projectDetailState.message}</p> : null}
        {projectDetailState.status === 'loading' ? <p className="muted">Loading project details...</p> : null}
        {projectDetailState.status === 'error' ? <p className="error">{projectDetailState.message}</p> : null}
        {projectDetailState.status === 'ready' ? (
          <>
            <div className="tableForm">
              <div className="panelHeader">
                <h3>Create Table</h3>
              </div>
              <div className="stack compactStack">
                <label className="field">
                  <span>Table Slug</span>
                  <input value={createTableDraft.tableSlug} onChange={(event) => setCreateTableDraft((current) => ({ ...current, tableSlug: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Sheet Tab</span>
                  <input value={createTableDraft.sheetTabName} onChange={(event) => setCreateTableDraft((current) => ({ ...current, sheetTabName: event.target.value }))} />
                </label>
                <label className="field">
                  <span>ID Column</span>
                  <input value={createTableDraft.idColumn} onChange={(event) => setCreateTableDraft((current) => ({ ...current, idColumn: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Indexed Fields</span>
                  <input value={createTableDraft.indexedFields} onChange={(event) => setCreateTableDraft((current) => ({ ...current, indexedFields: event.target.value }))} />
                </label>
                <label className="field">
                  <span>Cache TTL Seconds</span>
                  <input value={createTableDraft.cacheTtlSeconds} onChange={(event) => setCreateTableDraft((current) => ({ ...current, cacheTtlSeconds: event.target.value }))} />
                </label>
                <div className="actions">
                  <button type="button" onClick={() => void handleCreateTable()}>
                    Save table
                  </button>
                </div>
              </div>
            </div>

            {projectDetailState.tables.length === 0 ? <p className="muted">No tables configured yet.</p> : null}
            {projectDetailState.tables.length > 0 ? (
              <div className="cards">
                {projectDetailState.tables.map((table) => {
                  const cache = cacheStateByTable[table.tableSlug] ?? null;
                  return (
                    <article key={table.tableSlug} className="card">
                      <div className="cardTop">
                        <div>
                          <p className="slug">{table.tableSlug}</p>
                          <h3>{table.sheetTabName}</h3>
                        </div>
                        <span className="badge">{table.cacheTtlSeconds}s TTL</span>
                      </div>
                      <dl className="facts">
                        <div>
                          <dt>ID Column</dt>
                          <dd>{table.idColumn}</dd>
                        </div>
                        <div>
                          <dt>Indexed</dt>
                          <dd>{table.indexedFields.join(', ')}</dd>
                        </div>
                        {cache ? (
                          <div>
                            <dt>Cache</dt>
                            <dd>{cache.status} / {cache.staleReason} / {cache.rowCount} rows</dd>
                          </div>
                        ) : null}
                      </dl>
                      <div className="actions compactActions">
                        <button type="button" onClick={() => void handleLoadCache(table.tableSlug)}>
                          Load cache
                        </button>
                        <button type="button" className="secondaryButton" onClick={() => void handleReindex(table.tableSlug)}>
                          Reindex
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}

type CreateProjectDraft = {
  slug: string;
  name: string;
  spreadsheetId: string;
  defaultAuthMode: 'private' | 'public-read';
};

type CreateTableDraft = {
  tableSlug: string;
  sheetTabName: string;
  idColumn: string;
  indexedFields: string;
  cacheTtlSeconds: string;
};

type CreateKeyDraft = {
  name: string;
  projectScoped: boolean;
  scopes: ApiScope[];
};
