import { useEffect, useState } from 'react';
import type { ApiKeyPrincipal, ApiScope, ProjectSummary, TableConfig } from '@sheetflare/contracts';
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
  listApiKeys,
  listProjects,
  revokeApiKey,
  reindexTable
} from './api';
import { ApiKeySections } from './components/api-key-sections';
import { ProjectCards } from './components/project-cards';
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

type ProjectKeysState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ApiKeyPrincipal[] }
  | { status: 'error'; message: string };

type GlobalKeysState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ApiKeyPrincipal[] }
  | { status: 'error'; message: string; unauthorized: boolean };

type NoticeState =
  | { tone: 'idle'; message: string | null }
  | { tone: 'loading'; message: string }
  | { tone: 'success'; message: string }
  | { tone: 'error'; message: string };

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
  const [projectKeysState, setProjectKeysState] = useState<ProjectKeysState>({
    status: 'idle',
    message: 'Select a project to inspect and manage scoped API keys.'
  });
  const [globalKeysState, setGlobalKeysState] = useState<GlobalKeysState>({
    status: 'idle',
    message: 'Load a global admin credential to inspect global keys.'
  });
  const [cacheStateByTable, setCacheStateByTable] = useState<CacheStateByTable>({});
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>({
    tone: 'idle',
    message: null
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
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
      setProjectKeysState({
        status: 'idle',
        message: 'Select a project to inspect and manage scoped API keys.'
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

  useEffect(() => {
    if (!credential) {
      setGlobalKeysState({
        status: 'idle',
        message: 'Load a global admin credential to inspect global keys.'
      });
      return;
    }

    let cancelled = false;
    setGlobalKeysState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listApiKeys(credential);
        if (!cancelled) {
          setGlobalKeysState({
            status: 'ready',
            data: result.data.filter((apiKey) => apiKey.projectSlug === null)
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          setGlobalKeysState({
            status: 'error',
            message,
            unauthorized: message.includes('rejected') || message.includes('global admin key')
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
      setProjectKeysState({
        status: 'idle',
        message: 'Select a project to inspect and manage scoped API keys.'
      });
      return;
    }

    let cancelled = false;
    setProjectKeysState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listApiKeys(credential, selectedProjectSlug);
        if (!cancelled) {
          setProjectKeysState({
            status: 'ready',
            data: result.data
          });
        }
      } catch (error) {
        if (!cancelled) {
          setProjectKeysState({
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

  async function refreshProjectDetail(credentialValue: string, projectSlug: string) {
    const detail = await getProject(credentialValue, projectSlug);
    setProjectDetailState({
      status: 'ready',
      tables: detail.tables
    });
  }

  async function refreshProjectKeys(credentialValue: string, projectSlug: string) {
    const result = await listApiKeys(credentialValue, projectSlug);
    setProjectKeysState({
      status: 'ready',
      data: result.data
    });
  }

  async function refreshGlobalKeys(credentialValue: string) {
    const result = await listApiKeys(credentialValue);
    setGlobalKeysState({
      status: 'ready',
      data: result.data.filter((apiKey) => apiKey.projectSlug === null)
    });
  }

  async function runAction(actionLabel: string, work: () => Promise<void>) {
    setBusyAction(actionLabel);
    setNotice({
      tone: 'loading',
      message: actionLabel
    });

    try {
      await work();
      setNotice({
        tone: 'success',
        message: `${actionLabel} complete.`
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setBusyAction(null);
    }
  }

  function saveCredential() {
    const normalized = normalizeAdminCredential(draftCredential);
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, rememberCredential ? normalized : null);
    }

    setCredential(normalized);
    setDraftCredential(normalized ?? '');
    setNotice({
      tone: 'idle',
      message: null
    });
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
    setProjectKeysState({
      status: 'idle',
      message: 'Select a project to inspect and manage scoped API keys.'
    });
    setGlobalKeysState({
      status: 'idle',
      message: 'Load a global admin credential to inspect global keys.'
    });
    setNotice({
      tone: 'idle',
      message: null
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
    await runAction(`Saving project ${input.slug}`, async () => {
      await createProject(credential, input);
      setCreateProjectDraft({
        slug: '',
        name: '',
        spreadsheetId: '',
        defaultAuthMode: 'private'
      });
      await refreshProjects();
      setSelectedProjectSlug(input.slug);
    });
  }

  async function handleCreateTable() {
    if (!credential || !selectedProjectSlug) return;
    const tableInput = {
      tableSlug: createTableDraft.tableSlug.trim(),
      sheetTabName: createTableDraft.sheetTabName.trim(),
      idColumn: createTableDraft.idColumn.trim(),
      indexedFields: createTableDraft.indexedFields
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      cacheTtlSeconds: Number(createTableDraft.cacheTtlSeconds)
    };
    await runAction(`Saving table ${selectedProjectSlug}/${tableInput.tableSlug}`, async () => {
      await createTable(credential, selectedProjectSlug, tableInput);
      setCreateTableDraft({
        tableSlug: '',
        sheetTabName: '',
        idColumn: '_id',
        indexedFields: 'name,status',
        cacheTtlSeconds: '15'
      });
      await refreshProjectDetail(credential, selectedProjectSlug);
    });
  }

  async function handleCreateKey() {
    if (!credential) return;
    if (createKeyDraft.projectScoped && !selectedProjectSlug) return;
    const keyInput = {
      name: createKeyDraft.name.trim(),
      projectSlug: createKeyDraft.projectScoped ? selectedProjectSlug : null,
      scopes: createKeyDraft.scopes
    };
    await runAction(`Creating API key ${keyInput.name}`, async () => {
      const response = await createApiKey(credential, keyInput);
      setCreatedKey(response.apiKey);
      if (selectedProjectSlug) {
        await refreshProjectKeys(credential, selectedProjectSlug);
      }
      if (!keyInput.projectSlug) {
        await refreshGlobalKeys(credential);
      }
    });
  }

  async function handleLoadCache(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    await runAction(`Loading cache state for ${selectedProjectSlug}/${tableSlug}`, async () => {
      const response = await getCacheStatus(credential, selectedProjectSlug, tableSlug);
      setCacheStateByTable((current) => ({
        ...current,
        [tableSlug]: {
          status: response.data.status,
          staleReason: response.data.staleReason,
          rowCount: response.data.rowCount
        }
      }));
    });
  }

  async function handleReindex(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    await runAction(`Reindexing ${selectedProjectSlug}/${tableSlug}`, async () => {
      const response = await reindexTable(credential, selectedProjectSlug, tableSlug);
      setCacheStateByTable((current) => ({
        ...current,
        [tableSlug]: {
          status: response.cache.status,
          staleReason: response.cache.staleReason,
          rowCount: response.rowCount
        }
      }));
    });
  }

  async function handleRevokeKey(apiKeyId: string) {
    if (!credential) return;
    await runAction(`Revoking key ${apiKeyId}`, async () => {
      await revokeApiKey(credential, apiKeyId);
      setCreatedKey((current) => (current?.startsWith(`sfk_${apiKeyId}.`) ? null : current));
      if (selectedProjectSlug) {
        await refreshProjectKeys(credential, selectedProjectSlug);
      }
      await refreshGlobalKeys(credential);
    });
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
              Use a bootstrap admin token or a scoped admin API key. The credential is only stored locally if you opt in below.
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

        {notice.tone !== 'idle' && notice.message ? (
          <p className={notice.tone === 'error' ? 'error' : notice.tone === 'success' ? 'success' : 'muted'}>
            {notice.message}
          </p>
        ) : null}

        {state.status === 'idle' ? <p className="muted">{state.message}</p> : null}
        {state.status === 'loading' ? <p className="muted">Loading project registry...</p> : null}
        {state.status === 'error' ? (
          <p className="error">
            {state.message}
            {state.unauthorized ? ' Update the stored credential and try again.' : ''}
          </p>
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <p className="muted">No projects yet. Use the form below to create the first project.</p>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <ProjectCards
            projects={state.data}
            selectedProjectSlug={selectedProjectSlug}
            onSelect={setSelectedProjectSlug}
          />
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
              <button type="button" onClick={() => void handleCreateProject()} disabled={!credential || busyAction !== null}>
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
              <button
                type="button"
                onClick={() => void handleCreateKey()}
                disabled={!credential || createKeyDraft.scopes.length === 0 || (createKeyDraft.projectScoped && !selectedProjectSlug) || busyAction !== null}
              >
                Create key
              </button>
            </div>
            {createdKey ? <p className="success">New key: <code>{createdKey}</code></p> : null}
            {projectKeysState.status === 'idle' ? <p className="muted">{projectKeysState.message}</p> : null}
            {projectKeysState.status === 'loading' ? <p className="muted">Loading scoped keys...</p> : null}
            {projectKeysState.status === 'error' ? <p className="error">{projectKeysState.message}</p> : null}
            {projectKeysState.status === 'ready' && projectKeysState.data.length === 0 ? (
              <p className="muted">No scoped keys yet for this project.</p>
            ) : null}
            {projectKeysState.status === 'ready' && projectKeysState.data.length > 0 ? (
              <ApiKeySections
                keys={projectKeysState.data}
                onRevoke={(apiKeyId) => void handleRevokeKey(apiKeyId)}
                busy={busyAction !== null}
                emptyMessage="No scoped keys yet for this project."
                title="Selected Project Keys"
              />
            ) : null}
            <div className="stack compactStack">
              <h3>Global Admin Keys</h3>
              {globalKeysState.status === 'idle' ? <p className="muted">{globalKeysState.message}</p> : null}
              {globalKeysState.status === 'loading' ? <p className="muted">Loading global keys...</p> : null}
              {globalKeysState.status === 'error' ? (
                globalKeysState.unauthorized
                  ? <p className="muted">Global key listing requires a global admin credential.</p>
                  : <p className="error">{globalKeysState.message}</p>
              ) : null}
              {globalKeysState.status === 'ready' ? (
                <ApiKeySections
                  keys={globalKeysState.data}
                  onRevoke={(apiKeyId) => void handleRevokeKey(apiKeyId)}
                  busy={busyAction !== null}
                  emptyMessage="No global admin keys yet."
                />
              ) : null}
            </div>
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
                  <button type="button" onClick={() => void handleCreateTable()} disabled={busyAction !== null}>
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
                        <button type="button" onClick={() => void handleLoadCache(table.tableSlug)} disabled={busyAction !== null}>
                          Load cache
                        </button>
                        <button type="button" className="secondaryButton" onClick={() => void handleReindex(table.tableSlug)} disabled={busyAction !== null}>
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
