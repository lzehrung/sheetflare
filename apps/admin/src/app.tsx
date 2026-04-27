import { useEffect, useState } from 'react';
import type { ApiKeyPrincipal, ProjectConfig, ProjectSummary, TableCacheStatus, TableConfig } from '@sheetflare/contracts';
import {
  initialCreateKeyDraft,
  initialCreateProjectDraft,
  initialCreateTableDraft,
  validateCreateKeyDraft,
  validateCreateProjectDraft,
  validateCreateTableDraft,
  type CreateKeyDraft,
  type CreateProjectDraft,
  type CreateTableDraft
} from './admin-drafts';
import {
  createApiKey,
  createProject,
  createTable,
  getCacheStatus,
  getProject,
  listApiKeys,
  listProjects,
  refreshTableCache,
  revokeApiKey,
  reindexTable
} from './api';
import {
  normalizeAdminCredential,
  readStoredAdminCredential,
  writeStoredAdminCredential
} from './auth';
import { ApiKeyPanel } from './components/api-key-panel';
import { CredentialPanel } from './components/credential-panel';
import { CreateProjectForm } from './components/create-project-form';
import { NoticeBanner } from './components/notice-banner';
import { ProjectCards } from './components/project-cards';
import { SelectedProjectPanel } from './components/selected-project-panel';
import './styles.css';

type LoadState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ProjectSummary[] }
  | { status: 'error'; message: string; unauthorized: boolean };

type ProjectDetailState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectConfig; tables: TableConfig[] }
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

type CacheStateByTable = Record<string, TableCacheStatus | null>;
type CacheStatusErrorByTable = Record<string, string | null>;
type CacheStatusLoadingByTable = Record<string, boolean>;

function getInitialCredential() {
  if (typeof window === 'undefined') {
    return null;
  }

  return readStoredAdminCredential(window.localStorage);
}

function getSelectedProjectSlug(projects: ProjectSummary[], currentProjectSlug: string | null) {
  if (currentProjectSlug && projects.some((project) => project.slug === currentProjectSlug)) {
    return currentProjectSlug;
  }

  return projects[0]?.slug ?? null;
}

function getTableCacheKey(projectSlug: string, tableSlug: string) {
  return `${projectSlug}:${tableSlug}`;
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
  const [cacheStatusErrorByTable, setCacheStatusErrorByTable] = useState<CacheStatusErrorByTable>({});
  const [cacheStatusLoadingByTable, setCacheStatusLoadingByTable] = useState<CacheStatusLoadingByTable>({});
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>({
    tone: 'idle',
    message: null
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [createProjectDraft, setCreateProjectDraft] = useState<CreateProjectDraft>(initialCreateProjectDraft);
  const [createTableDraft, setCreateTableDraft] = useState<CreateTableDraft>(initialCreateTableDraft);
  const [createKeyDraft, setCreateKeyDraft] = useState<CreateKeyDraft>(initialCreateKeyDraft);

  const createProjectValidation = validateCreateProjectDraft(createProjectDraft);
  const createTableValidation = validateCreateTableDraft(createTableDraft);
  const createKeyValidation = validateCreateKeyDraft(createKeyDraft, selectedProjectSlug);

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
          setSelectedProjectSlug((current) => getSelectedProjectSlug(body.data, current));
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
    setCreatedKey(null);
  }, [selectedProjectSlug]);

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
            project: detail.project,
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

  useEffect(() => {
    if (!credential || projectDetailState.status !== 'ready' || projectDetailState.tables.length === 0) {
      return;
    }

    let cancelled = false;
    const tableEntries = projectDetailState.tables.map((table) => ({
      table,
      cacheKey: getTableCacheKey(table.projectSlug, table.tableSlug)
    }));

    setCacheStatusLoadingByTable((current) => ({
      ...current,
      ...Object.fromEntries(tableEntries.map((entry) => [entry.cacheKey, true]))
    }));
    setCacheStatusErrorByTable((current) => ({
      ...current,
      ...Object.fromEntries(tableEntries.map((entry) => [entry.cacheKey, null]))
    }));

    void (async () => {
      const results = await Promise.all(
        tableEntries.map(async (entry) => {
          try {
            const response = await getCacheStatus(credential, entry.table.projectSlug, entry.table.tableSlug);
            return {
              cache: response.data,
              cacheKey: entry.cacheKey,
              errorMessage: null,
              ok: true as const
            };
          } catch (error) {
            return {
              cache: null,
              cacheKey: entry.cacheKey,
              errorMessage: error instanceof Error ? error.message : 'Unknown error',
              ok: false as const
            };
          }
        })
      );

      if (cancelled) {
        return;
      }

      setCacheStateByTable((current) => ({
        ...current,
        ...Object.fromEntries(results.filter((result) => result.ok).map((result) => [result.cacheKey, result.cache]))
      }));
      setCacheStatusErrorByTable((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.cacheKey, result.errorMessage]))
      }));
      setCacheStatusLoadingByTable((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.cacheKey, false]))
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [credential, projectDetailState]);

  async function refreshProjects(credentialValue: string) {
    const body = await listProjects(credentialValue);
    setState({ status: 'ready', data: body.data });
    setSelectedProjectSlug((current) => getSelectedProjectSlug(body.data, current));
  }

  async function refreshProjectDetail(
    credentialValue: string,
    projectSlug: string,
    options?: { showLoading?: boolean }
  ) {
    if (options?.showLoading) {
      setProjectDetailState({ status: 'loading' });
    }

    const detail = await getProject(credentialValue, projectSlug);
    setProjectDetailState({
      status: 'ready',
      project: detail.project,
      tables: detail.tables
    });
  }

  async function refreshProjectKeys(
    credentialValue: string,
    projectSlug: string,
    options?: { showLoading?: boolean }
  ) {
    if (options?.showLoading) {
      setProjectKeysState({ status: 'loading' });
    }

    const result = await listApiKeys(credentialValue, projectSlug);
    setProjectKeysState({
      status: 'ready',
      data: result.data
    });
  }

  async function refreshGlobalKeys(
    credentialValue: string,
    options?: { showLoading?: boolean }
  ) {
    if (options?.showLoading) {
      setGlobalKeysState({ status: 'loading' });
    }

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
    setCacheStateByTable({});
    setCreatedKey(null);
    setDraftCredential(normalized ?? '');
    setNotice({
      tone: 'idle',
      message: null
    });
  }

  function setCacheStatusLoading(projectSlug: string, tableSlug: string, loading: boolean) {
    const cacheKey = getTableCacheKey(projectSlug, tableSlug);
    setCacheStatusLoadingByTable((current) => ({
      ...current,
      [cacheKey]: loading
    }));
  }

  function setCacheStatusError(projectSlug: string, tableSlug: string, message: string | null) {
    const cacheKey = getTableCacheKey(projectSlug, tableSlug);
    setCacheStatusErrorByTable((current) => ({
      ...current,
      [cacheKey]: message
    }));
  }

  function setCacheStatusValue(projectSlug: string, tableSlug: string, cache: TableCacheStatus) {
    const cacheKey = getTableCacheKey(projectSlug, tableSlug);
    setCacheStateByTable((current) => ({
      ...current,
      [cacheKey]: cache
    }));
  }

  async function fetchCacheStatusForTable(credentialValue: string, projectSlug: string, tableSlug: string) {
    setCacheStatusLoading(projectSlug, tableSlug, true);
    setCacheStatusError(projectSlug, tableSlug, null);

    try {
      const response = await getCacheStatus(credentialValue, projectSlug, tableSlug);
      setCacheStatusValue(projectSlug, tableSlug, response.data);
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setCacheStatusError(projectSlug, tableSlug, message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setCacheStatusLoading(projectSlug, tableSlug, false);
    }
  }

  function clearCredential() {
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, null);
    }

    setCredential(null);
    setCacheStateByTable({});
    setCacheStatusErrorByTable({});
    setCacheStatusLoadingByTable({});
    setCreatedKey(null);
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

  async function handleCreateProject() {
    if (!credential || !createProjectValidation.value) return;
    const input = createProjectValidation.value;

    await runAction(`Saving project ${input.slug}`, async () => {
      await createProject(credential, input);
      setCreateProjectDraft(initialCreateProjectDraft);
      await refreshProjects(credential);
      setSelectedProjectSlug(input.slug);
    });
  }

  async function handleCreateTable() {
    if (!credential || !selectedProjectSlug || !createTableValidation.value) return;
    const input = createTableValidation.value;

    await runAction(`Saving table ${selectedProjectSlug}/${input.tableSlug}`, async () => {
      await createTable(credential, selectedProjectSlug, input);
      setCreateTableDraft(initialCreateTableDraft);
      await refreshProjectDetail(credential, selectedProjectSlug);
    });
  }

  async function handleCreateKey() {
    if (!credential || !createKeyValidation.value) return;
    const validatedInput = createKeyValidation.value;
    const input = {
      name: validatedInput.name,
      scopes: validatedInput.scopes,
      ...(validatedInput.projectSlug !== undefined ? { projectSlug: validatedInput.projectSlug } : {})
    };

    await runAction(`Creating API key ${input.name}`, async () => {
      const response = await createApiKey(credential, input);
      setCreatedKey(response.apiKey);
      if (selectedProjectSlug) {
        await refreshProjectKeys(credential, selectedProjectSlug);
      }
      if (!input.projectSlug) {
        await refreshGlobalKeys(credential);
      }
    });
  }

  async function handleLoadCache(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    await runAction(`Getting cache status for ${selectedProjectSlug}/${tableSlug}`, async () => {
      await fetchCacheStatusForTable(credential, selectedProjectSlug, tableSlug);
    });
  }

  async function handleRefreshIfStale(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    setCacheStatusLoading(selectedProjectSlug, tableSlug, true);
    setCacheStatusError(selectedProjectSlug, tableSlug, null);

    await runAction(`Refreshing cache for ${selectedProjectSlug}/${tableSlug} if stale`, async () => {
      try {
        const response = await refreshTableCache(credential, selectedProjectSlug, tableSlug);
        setCacheStatusValue(selectedProjectSlug, tableSlug, response.cache);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        setCacheStatusError(selectedProjectSlug, tableSlug, message);
        throw error;
      } finally {
        setCacheStatusLoading(selectedProjectSlug, tableSlug, false);
      }
    });
  }

  async function handleReindex(tableSlug: string) {
    if (!credential || !selectedProjectSlug) return;
    setCacheStatusLoading(selectedProjectSlug, tableSlug, true);
    setCacheStatusError(selectedProjectSlug, tableSlug, null);

    await runAction(`Reindexing ${selectedProjectSlug}/${tableSlug}`, async () => {
      try {
        const response = await reindexTable(credential, selectedProjectSlug, tableSlug);
        setCacheStatusValue(selectedProjectSlug, tableSlug, response.cache);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        setCacheStatusError(selectedProjectSlug, tableSlug, message);
        throw error;
      } finally {
        setCacheStatusLoading(selectedProjectSlug, tableSlug, false);
      }
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

  async function handleRefreshProjects() {
    if (!credential) return;
    setState({ status: 'loading' });
    await runAction('Refreshing project registry', async () => {
      await refreshProjects(credential);
    });
  }

  async function handleRefreshSelectedProject() {
    if (!credential || !selectedProjectSlug) return;
    await runAction(`Refreshing project ${selectedProjectSlug}`, async () => {
      await refreshProjectDetail(credential, selectedProjectSlug, { showLoading: true });
    });
  }

  async function handleRefreshProjectKeys() {
    if (!credential || !selectedProjectSlug) return;
    await runAction(`Refreshing keys for ${selectedProjectSlug}`, async () => {
      await refreshProjectKeys(credential, selectedProjectSlug, { showLoading: true });
    });
  }

  async function handleRefreshGlobalKeys() {
    if (!credential) return;
    await runAction('Refreshing global admin keys', async () => {
      await refreshGlobalKeys(credential, { showLoading: true });
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

      <CredentialPanel
        credentialConfigured={Boolean(credential)}
        draftCredential={draftCredential}
        rememberCredential={rememberCredential}
        onDraftCredentialChange={setDraftCredential}
        onRememberCredentialChange={setRememberCredential}
        onSave={saveCredential}
        onClear={clearCredential}
        saveDisabled={draftCredential.trim().length === 0}
        busy={busyAction !== null}
      />

      <section className="panel">
        <div className="panelHeader">
          <h2>Projects</h2>
          <div className="actions compactHeaderActions">
            <button type="button" className="secondaryButton" onClick={() => void handleRefreshProjects()} disabled={!credential || busyAction !== null}>
              Refresh projects
            </button>
            <span className="badge">{projectCount}</span>
          </div>
        </div>

        <NoticeBanner tone={notice.tone} message={notice.message} />

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
        <CreateProjectForm
          draft={createProjectDraft}
          fieldErrors={createProjectValidation.fieldErrors}
          onChange={setCreateProjectDraft}
          onSubmit={() => void handleCreateProject()}
          submitDisabled={!credential || busyAction !== null || !createProjectValidation.isValid}
        />
        <ApiKeyPanel
          selectedProjectSlug={selectedProjectSlug}
          draft={createKeyDraft}
          fieldErrors={createKeyValidation.fieldErrors}
          onChange={setCreateKeyDraft}
          onSubmit={() => void handleCreateKey()}
          submitDisabled={!credential || busyAction !== null || !createKeyValidation.isValid}
          createdKey={createdKey}
          projectKeysState={projectKeysState}
          globalKeysState={globalKeysState}
          busy={busyAction !== null}
          onRevoke={(apiKeyId) => void handleRevokeKey(apiKeyId)}
          onRefreshProjectKeys={() => void handleRefreshProjectKeys()}
          onRefreshGlobalKeys={() => void handleRefreshGlobalKeys()}
        />
      </section>

      <SelectedProjectPanel
        selectedProjectSlug={selectedProjectSlug}
        detailState={projectDetailState}
        createTableDraft={createTableDraft}
        tableFieldErrors={createTableValidation.fieldErrors}
        cacheStateByTable={cacheStateByTable}
        cacheStatusErrorByTable={cacheStatusErrorByTable}
        cacheStatusLoadingByTable={cacheStatusLoadingByTable}
        onCreateTableDraftChange={setCreateTableDraft}
        onCreateTable={() => void handleCreateTable()}
        onLoadCache={(tableSlug) => void handleLoadCache(tableSlug)}
        onRefreshIfStale={(tableSlug) => void handleRefreshIfStale(tableSlug)}
        onReindex={(tableSlug) => void handleReindex(tableSlug)}
        onRefresh={() => void handleRefreshSelectedProject()}
        busy={busyAction !== null}
        createTableDisabled={!credential || !selectedProjectSlug || busyAction !== null || !createTableValidation.isValid}
        getTableCacheKey={getTableCacheKey}
      />
    </main>
  );
}
