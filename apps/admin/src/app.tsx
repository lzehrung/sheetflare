import { useEffect, useState } from 'react';
import type {
  AdminGetProjectResult,
  AdminInspectSpreadsheetTabResult,
  ApiKeyPrincipal,
  ProjectConfig,
  ProjectSummary,
  SpreadsheetWatch,
  SpreadsheetTab,
  TableCacheStatus,
  TableConfig
} from '@sheetflare/contracts';
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
  classifyAuthFailure,
  createApiKey,
  createProject,
  createTable,
  deleteProject,
  deleteTable,
  getAdminSession,
  getCacheStatus,
  getProject,
  inspectSpreadsheetTab,
  listApiKeys,
  listProjects,
  listSpreadsheetWatches,
  listSpreadsheetTabs,
  refreshTableCache,
  revokeApiKey,
  reindexTable,
  type AdminAuthFailure
} from './api';
import {
  adminCredentialStorageKey,
  normalizeAdminCredential,
  type AdminAccess
} from './auth';
import { forEachWithConcurrency } from './concurrency';
import { useRequestGeneration } from './request-generation';
import { ApiKeyPanel } from './components/api-key-panel';
import { CredentialPanel } from './components/credential-panel';
import { CreateProjectForm } from './components/create-project-form';
import { NoticeBanner } from './components/notice-banner';
import { ProjectCards } from './components/project-cards';
import { ProjectScopeEntry, type ProjectScopeEntryState } from './components/project-scope-entry';
import { RefreshWarning } from './components/refresh-warning';
import { SelectedProjectPanel } from './components/selected-project-panel';
import './styles.css';

type LoadState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ProjectSummary[] }
  | { status: 'scope-limited'; message: string }
  | { status: 'error'; message: string; authFailure: AdminAuthFailure | null };

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
  | { status: 'error'; message: string; authFailure: AdminAuthFailure | null };

// 'unknown' until the registry probe settles; 'project' means the key is valid but not global.
type AdminScope = 'unknown' | 'global' | 'project';

type RefreshWarningState = {
  message: string;
  retry: () => Promise<void>;
};

type NoticeState =
  | { tone: 'idle'; message: string | null }
  | { tone: 'loading'; message: string }
  | { tone: 'success'; message: string }
  | { tone: 'error'; message: string };

type CacheStateByTable = Record<string, TableCacheStatus | null>;
type CacheStatusErrorByTable = Record<string, string | null>;
type CacheStatusLoadingByTable = Record<string, boolean>;
type SpreadsheetTabsState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: SpreadsheetTab[] }
  | { status: 'error'; message: string };

type TabInspectionState =
  | { status: 'idle'; message: string }
  | { status: 'loading'; tabName: string; headerRow: number }
  | { status: 'ready'; data: AdminInspectSpreadsheetTabResult['data'] }
  | { status: 'error'; message: string; tabName: string; headerRow: number };

type SpreadsheetWatchState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; watch: SpreadsheetWatch | null }
  | { status: 'error'; message: string };

const cacheStatusConcurrency = 4;

const projectKeyPromptMessage =
  'This credential is valid but is not a global admin key, so it cannot list every project. Enter the slug of the project it is scoped to. The project registry, global keys, and spreadsheet watches are skipped for project-scoped keys.';
const projectScopedGlobalKeysMessage =
  'Global keys are only available to a global admin key. This project-scoped key manages keys for its own project.';
const projectScopedWatchMessage = 'Spreadsheet watch status requires a global admin key.';

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const authFailure = classifyAuthFailure(error);
  if (authFailure === 'invalid-credential') {
    return `${message} The Worker rejected this credential; check it or enter another.`;
  }

  if (authFailure === 'insufficient-scope') {
    return `${message} This credential is valid but lacks the scope or project access for this action.`;
  }

  return message;
}

function summarizeProject(detail: AdminGetProjectResult): ProjectSummary {
  return {
    slug: detail.project.slug,
    name: detail.project.name,
    spreadsheetId: detail.project.spreadsheetId,
    googleCredentialRef: detail.project.googleCredentialRef,
    tableCount: detail.tables.length,
    updatedAt: detail.project.updatedAt
  };
}

async function fetchRegistry(
  access: AdminAccess,
  projectScopeSlug: string | null,
  signal?: AbortSignal
): Promise<ProjectSummary[]> {
  if (projectScopeSlug === null) {
    return (await listProjects(access, signal)).data;
  }

  return [summarizeProject(await getProject(access, projectScopeSlug, signal))];
}

function upsertBySlug<Entry extends { slug: string }>(entries: Entry[], entry: Entry): Entry[] {
  return entries.some((candidate) => candidate.slug === entry.slug)
    ? entries.map((candidate) => (candidate.slug === entry.slug ? entry : candidate))
    : [...entries, entry];
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

function slugifyTableEntity(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function countTableHealth(
  projectSlug: string,
  tables: TableConfig[],
  cacheStateByTable: CacheStateByTable,
  cacheStatusErrorByTable: CacheStatusErrorByTable,
  cacheStatusLoadingByTable: CacheStatusLoadingByTable
) {
  return tables.reduce(
    (summary, table) => {
      const cacheKey = getTableCacheKey(projectSlug, table.tableSlug);
      if (cacheStatusLoadingByTable[cacheKey]) {
        summary.loading += 1;
        return summary;
      }

      if (cacheStatusErrorByTable[cacheKey]) {
        summary.error += 1;
        return summary;
      }

      const cache = cacheStateByTable[cacheKey];
      if (!cache) {
        summary.pending += 1;
        return summary;
      }

      if (cache.status === 'error') {
        summary.error += 1;
        return summary;
      }

      if (cache.stale) {
        summary.stale += 1;
        return summary;
      }

      summary.healthy += 1;
      return summary;
    },
    {
      healthy: 0,
      stale: 0,
      error: 0,
      loading: 0,
      pending: 0
    }
  );
}

type ServerCredentialState = 'checking' | 'available' | 'unavailable';

function getCredentialStatus(
  access: AdminAccess | null,
  serverCredentialState: ServerCredentialState,
  state: LoadState,
  adminScope: AdminScope
) {
  if (!access) {
    return serverCredentialState === 'checking' ? 'checking' as const : 'required' as const;
  }

  if (state.status === 'loading') {
    return 'checking' as const;
  }

  if (state.status === 'scope-limited') {
    return 'project-scoped' as const;
  }

  if (state.status === 'ready') {
    return adminScope === 'project' ? 'project-scoped' as const : 'configured' as const;
  }

  if (state.status === 'error') {
    return state.authFailure === 'invalid-credential' ? 'rejected' as const : 'error' as const;
  }

  return 'checking' as const;
}

export function App() {
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [serverCredentialState, setServerCredentialState] = useState<ServerCredentialState>('checking');
  const [draftCredential, setDraftCredential] = useState<string>('');
  const [state, setState] = useState<LoadState>({
    status: 'idle',
    message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
  });
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null);
  const [projectDetailState, setProjectDetailState] = useState<ProjectDetailState>({
    status: 'idle',
    message: 'Select a project to inspect tables, cache state, and keys.'
  });
  const [projectKeysState, setProjectKeysState] = useState<ProjectKeysState>({
    status: 'idle',
    message: 'Select a project to inspect and manage scoped API keys.'
  });
  const [adminScope, setAdminScope] = useState<AdminScope>('unknown');
  const [projectScopeSlug, setProjectScopeSlug] = useState<string | null>(null);
  const [projectScopeEntry, setProjectScopeEntry] = useState<ProjectScopeEntryState>({ status: 'idle' });
  const [refreshWarning, setRefreshWarning] = useState<RefreshWarningState | null>(null);
  const [globalKeysState, setGlobalKeysState] = useState<GlobalKeysState>({
    status: 'idle',
    message: 'Load a global admin credential to inspect global keys.'
  });
  const [cacheStateByTable, setCacheStateByTable] = useState<CacheStateByTable>({});
  const [cacheStatusErrorByTable, setCacheStatusErrorByTable] = useState<CacheStatusErrorByTable>({});
  const [cacheStatusLoadingByTable, setCacheStatusLoadingByTable] = useState<CacheStatusLoadingByTable>({});
  const [spreadsheetTabsState, setSpreadsheetTabsState] = useState<SpreadsheetTabsState>({
    status: 'idle',
    message: 'Open table setup to load spreadsheet tabs.'
  });
  const [tabInspectionState, setTabInspectionState] = useState<TabInspectionState>({
    status: 'idle',
    message: 'Choose a sheet tab to preview its headers.'
  });
  const [spreadsheetWatchState, setSpreadsheetWatchState] = useState<SpreadsheetWatchState>({
    status: 'idle',
    message: 'Select a project to inspect spreadsheet watch status.'
  });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>({
    tone: 'idle',
    message: null
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [projectSetupOpen, setProjectSetupOpen] = useState(false);
  const [tableSetupOpen, setTableSetupOpen] = useState(false);
  const [accessKeysOpen, setAccessKeysOpen] = useState(false);
  const [createProjectDraft, setCreateProjectDraft] = useState<CreateProjectDraft>(initialCreateProjectDraft);
  const [createTableDraft, setCreateTableDraft] = useState<CreateTableDraft>(initialCreateTableDraft);
  const [createKeyDraft, setCreateKeyDraft] = useState<CreateKeyDraft>(initialCreateKeyDraft);

  const registryGeneration = useRequestGeneration();
  const detailGeneration = useRequestGeneration();
  const projectKeysGeneration = useRequestGeneration();
  const globalKeysGeneration = useRequestGeneration();

  const createProjectValidation = validateCreateProjectDraft(createProjectDraft);
  const createTableValidation = validateCreateTableDraft(createTableDraft);
  const createKeyValidation = validateCreateKeyDraft(createKeyDraft, selectedProjectSlug);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.removeItem(adminCredentialStorageKey);
    window.sessionStorage.removeItem(adminCredentialStorageKey);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await getAdminSession();
        if (cancelled) {
          return;
        }

        if (session.serverCredential) {
          setServerCredentialState('available');
          setAccess((current) => current ?? { source: 'local-server' });
        } else {
          setServerCredentialState('unavailable');
        }
      } catch {
        if (!cancelled) {
          setServerCredentialState('unavailable');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const generationId = registryGeneration.begin();
    setAdminScope('unknown');
    setProjectScopeSlug(null);
    setProjectScopeEntry({ status: 'idle' });

    if (!access) {
      setState({
        status: 'idle',
        message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
      });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const body = await listProjects(access, controller.signal);
        if (controller.signal.aborted || !registryGeneration.isCurrent(generationId)) {
          return;
        }

        setAdminScope('global');
        setState({ status: 'ready', data: body.data });
        setSelectedProjectSlug((current) => getSelectedProjectSlug(body.data, current));
      } catch (error) {
        if (controller.signal.aborted || !registryGeneration.isCurrent(generationId)) {
          return;
        }

        const authFailure = classifyAuthFailure(error);
        if (authFailure === 'insufficient-scope') {
          setAdminScope('project');
          setSelectedProjectSlug(null);
          setState({ status: 'scope-limited', message: projectKeyPromptMessage });
          return;
        }

        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          authFailure
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [access]);

  useEffect(() => {
    setCreatedKey(null);
  }, [selectedProjectSlug]);

  useEffect(() => {
    const generationId = detailGeneration.begin();

    if (!access || !selectedProjectSlug) {
      setProjectDetailState({
        status: 'idle',
        message: 'Select a project to inspect tables, cache state, and keys.'
      });
      setSpreadsheetWatchState({
        status: 'idle',
        message: 'Select a project to inspect spreadsheet watch status.'
      });
      setProjectKeysState({
        status: 'idle',
        message: 'Select a project to inspect and manage scoped API keys.'
      });
      return;
    }

    const controller = new AbortController();
    setProjectDetailState({ status: 'loading' });

    void (async () => {
      try {
        const detail = await getProject(access, selectedProjectSlug, controller.signal);
        if (controller.signal.aborted || !detailGeneration.isCurrent(generationId)) {
          return;
        }

        setProjectDetailState({
          status: 'ready',
          project: detail.project,
          tables: detail.tables
        });
      } catch (error) {
        if (controller.signal.aborted || !detailGeneration.isCurrent(generationId)) {
          return;
        }

        setProjectDetailState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [access, selectedProjectSlug]);

  useEffect(() => {
    if (!access || !selectedProjectSlug || adminScope === 'unknown') {
      setSpreadsheetWatchState({
        status: 'idle',
        message: 'Select a project to inspect spreadsheet watch status.'
      });
      return;
    }

    if (adminScope === 'project') {
      setSpreadsheetWatchState({ status: 'idle', message: projectScopedWatchMessage });
      return;
    }

    if (projectDetailState.status !== 'ready') {
      setSpreadsheetWatchState({ status: 'loading' });
      return;
    }

    let cancelled = false;
    setSpreadsheetWatchState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listSpreadsheetWatches(access);
        const watch = result.data.find((entry) => entry.spreadsheetId === projectDetailState.project.spreadsheetId) ?? null;
        if (!cancelled) {
          setSpreadsheetWatchState({
            status: 'ready',
            watch
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSpreadsheetWatchState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    access,
    adminScope,
    selectedProjectSlug,
    projectDetailState.status,
    projectDetailState.status === 'ready' ? projectDetailState.project.spreadsheetId : null
  ]);

  useEffect(() => {
    if (!access || !selectedProjectSlug || projectDetailState.status !== 'ready' || !tableSetupOpen) {
      setSpreadsheetTabsState({
        status: 'idle',
        message: !selectedProjectSlug ? 'Select a project to load spreadsheet tabs.' : 'Open table setup to load spreadsheet tabs.'
      });
      return;
    }

    let cancelled = false;
    setSpreadsheetTabsState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listSpreadsheetTabs(access, selectedProjectSlug);
        if (!cancelled) {
          setSpreadsheetTabsState({
            status: 'ready',
            data: result.data
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSpreadsheetTabsState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [access, selectedProjectSlug, projectDetailState.status, tableSetupOpen]);

  useEffect(() => {
    if (!access || !selectedProjectSlug || !tableSetupOpen) {
      setTabInspectionState({
        status: 'idle',
        message: 'Choose a sheet tab to preview its headers.'
      });
      return;
    }

    const tabName = createTableDraft.sheetTabName.trim();
    const headerRow = Number.parseInt(createTableDraft.headerRow.trim(), 10);
    if (!tabName || !Number.isInteger(headerRow) || headerRow <= 0) {
      setTabInspectionState({
        status: 'idle',
        message: 'Choose a sheet tab to preview its headers.'
      });
      return;
    }

    let cancelled = false;
    setTabInspectionState({
      status: 'loading',
      tabName,
      headerRow
    });

    void (async () => {
      try {
        const result = await inspectSpreadsheetTab(access, selectedProjectSlug, tabName, headerRow);
        if (cancelled) {
          return;
        }

        setTabInspectionState({
          status: 'ready',
          data: result.data
        });
        setCreateTableDraft((current) => {
          const nextSheetGid = String(result.data.tab.sheetGid);
          const nextTableSlug = current.tableSlug.trim().length === 0 ? slugifyTableEntity(result.data.tab.title) : current.tableSlug;
          if (current.sheetGid === nextSheetGid && current.tableSlug === nextTableSlug) {
            return current;
          }

          return {
            ...current,
            sheetGid: nextSheetGid,
            tableSlug: nextTableSlug
          };
        });
      } catch (error) {
        if (!cancelled) {
          setTabInspectionState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
            tabName,
            headerRow
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [access, selectedProjectSlug, createTableDraft.sheetTabName, createTableDraft.headerRow, tableSetupOpen]);

  useEffect(() => {
    const generationId = globalKeysGeneration.begin();

    if (!access || adminScope === 'unknown') {
      setGlobalKeysState({
        status: 'idle',
        message: 'Load a global admin credential to inspect global keys.'
      });
      return;
    }

    if (adminScope === 'project') {
      setGlobalKeysState({ status: 'idle', message: projectScopedGlobalKeysMessage });
      return;
    }

    let cancelled = false;
    setGlobalKeysState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listApiKeys(access);
        if (!cancelled && globalKeysGeneration.isCurrent(generationId)) {
          setGlobalKeysState({
            status: 'ready',
            data: result.data.filter((apiKey) => apiKey.projectSlug === null)
          });
        }
      } catch (error) {
        if (!cancelled && globalKeysGeneration.isCurrent(generationId)) {
          setGlobalKeysState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
            authFailure: classifyAuthFailure(error)
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [access, adminScope]);

  useEffect(() => {
    const generationId = projectKeysGeneration.begin();

    if (!access || !selectedProjectSlug) {
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
        const result = await listApiKeys(access, selectedProjectSlug);
        if (!cancelled && projectKeysGeneration.isCurrent(generationId)) {
          setProjectKeysState({
            status: 'ready',
            data: result.data
          });
        }
      } catch (error) {
        if (!cancelled && projectKeysGeneration.isCurrent(generationId)) {
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
  }, [access, selectedProjectSlug]);

  useEffect(() => {
    if (!access || projectDetailState.status !== 'ready' || projectDetailState.tables.length === 0) {
      return;
    }

    const controller = new AbortController();
    const tableEntries = projectDetailState.tables.map((table) => ({
      table,
      cacheKey: getTableCacheKey(table.projectSlug, table.tableSlug)
    }));
    const unsettledCacheKeys = new Set(tableEntries.map((entry) => entry.cacheKey));

    setCacheStatusLoadingByTable((current) => ({
      ...current,
      ...Object.fromEntries(tableEntries.map((entry) => [entry.cacheKey, true]))
    }));
    setCacheStatusErrorByTable((current) => ({
      ...current,
      ...Object.fromEntries(tableEntries.map((entry) => [entry.cacheKey, null]))
    }));

    // Bounded fan-out: at most `cacheStatusConcurrency` requests in flight; each result renders as it settles.
    void forEachWithConcurrency(tableEntries, cacheStatusConcurrency, controller.signal, async (entry) => {
      try {
        const response = await getCacheStatus(access, entry.table.projectSlug, entry.table.tableSlug, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        unsettledCacheKeys.delete(entry.cacheKey);
        setCacheStateByTable((current) => ({ ...current, [entry.cacheKey]: response.data }));
        setCacheStatusErrorByTable((current) => ({ ...current, [entry.cacheKey]: null }));
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        unsettledCacheKeys.delete(entry.cacheKey);
        setCacheStatusErrorByTable((current) => ({
          ...current,
          [entry.cacheKey]: error instanceof Error ? error.message : 'Unknown error'
        }));
      }

      setCacheStatusLoadingByTable((current) => ({ ...current, [entry.cacheKey]: false }));
    });

    return () => {
      controller.abort();
      const abandoned = [...unsettledCacheKeys];
      setCacheStatusLoadingByTable((current) => ({
        ...current,
        ...Object.fromEntries(abandoned.map((cacheKey) => [cacheKey, false]))
      }));
    };
  }, [access, projectDetailState]);

  useEffect(() => {
    if (state.status === 'ready' && state.data.length === 0) {
      setProjectSetupOpen(true);
    }
  }, [state]);

  useEffect(() => {
    if (projectDetailState.status === 'ready' && projectDetailState.tables.length === 0) {
      setTableSetupOpen(true);
    }
  }, [projectDetailState]);

  async function refreshProjects(requestAccess: AdminAccess) {
    const generationId = registryGeneration.begin();
    const data = await fetchRegistry(requestAccess, projectScopeSlug);
    if (!registryGeneration.isCurrent(generationId)) {
      return;
    }

    setState({ status: 'ready', data });
    setSelectedProjectSlug((current) => getSelectedProjectSlug(data, current));
  }

  async function refreshProjectDetail(
    requestAccess: AdminAccess,
    projectSlug: string,
    options?: { showLoading?: boolean }
  ) {
    const generationId = detailGeneration.begin();
    if (options?.showLoading) {
      setProjectDetailState({ status: 'loading' });
    }

    const detail = await getProject(requestAccess, projectSlug);
    if (!detailGeneration.isCurrent(generationId)) {
      return;
    }

    setProjectDetailState({
      status: 'ready',
      project: detail.project,
      tables: detail.tables
    });
  }

  async function refreshProjectKeys(
    requestAccess: AdminAccess,
    projectSlug: string,
    options?: { showLoading?: boolean }
  ) {
    const generationId = projectKeysGeneration.begin();
    if (options?.showLoading) {
      setProjectKeysState({ status: 'loading' });
    }

    const result = await listApiKeys(requestAccess, projectSlug);
    if (!projectKeysGeneration.isCurrent(generationId)) {
      return;
    }

    setProjectKeysState({
      status: 'ready',
      data: result.data
    });
  }

  async function refreshGlobalKeys(
    requestAccess: AdminAccess,
    options?: { showLoading?: boolean }
  ) {
    const generationId = globalKeysGeneration.begin();
    if (options?.showLoading) {
      setGlobalKeysState({ status: 'loading' });
    }

    const result = await listApiKeys(requestAccess);
    if (!globalKeysGeneration.isCurrent(generationId)) {
      return;
    }

    setGlobalKeysState({
      status: 'ready',
      data: result.data.filter((apiKey) => apiKey.projectSlug === null)
    });
  }

  async function runAction(actionLabel: string, work: () => Promise<void>) {
    setBusyAction(actionLabel);
    setRefreshWarning(null);
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
        message: describeError(error)
      });
    } finally {
      setBusyAction(null);
    }
  }

  // A mutation that the Worker accepted is never reported as failed because the follow-up refresh failed:
  // the returned data is committed locally first and a refresh failure becomes a separate, retryable warning.
  async function runMutation<Result>(options: {
    label: string;
    mutate: () => Promise<Result>;
    commit: (result: Result) => void;
    refresh?: () => Promise<void>;
  }) {
    const { label, mutate, commit, refresh } = options;
    setBusyAction(label);
    setRefreshWarning(null);
    setNotice({
      tone: 'loading',
      message: label
    });

    let result: Result;
    try {
      result = await mutate();
    } catch (error) {
      setNotice({
        tone: 'error',
        message: describeError(error)
      });
      setBusyAction(null);
      return;
    }

    commit(result);

    if (refresh) {
      try {
        await refresh();
      } catch (error) {
        setRefreshWarning({
          message: `${label} succeeded, but refreshing the view failed: ${describeError(error)}`,
          retry: refresh
        });
      }
    }

    setNotice({
      tone: 'success',
      message: `${label} complete.`
    });
    setBusyAction(null);
  }

  async function handleRetryRefresh() {
    if (!refreshWarning) return;
    const { retry } = refreshWarning;
    setBusyAction('Retrying refresh');

    try {
      await retry();
      setRefreshWarning(null);
      setNotice({
        tone: 'success',
        message: 'Refresh complete.'
      });
    } catch (error) {
      setRefreshWarning({
        message: `Refreshing the view failed again: ${describeError(error)}`,
        retry
      });
    } finally {
      setBusyAction(null);
    }
  }

  function getDefaultAccess(): AdminAccess | null {
    return serverCredentialState === 'available' ? { source: 'local-server' } : null;
  }

  function saveCredential() {
    const normalized = normalizeAdminCredential(draftCredential);
    setAccess(normalized ? { source: 'browser', credential: normalized } : getDefaultAccess());
    setCacheStateByTable({});
    setCreatedKey(null);
    setRefreshWarning(null);
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

  function removeTableCacheEntries(cacheKey: string) {
    setCacheStateByTable((current) => {
      const { [cacheKey]: removed, ...rest } = current;
      void removed;
      return rest;
    });
    setCacheStatusErrorByTable((current) => {
      const { [cacheKey]: removed, ...rest } = current;
      void removed;
      return rest;
    });
    setCacheStatusLoadingByTable((current) => {
      const { [cacheKey]: removed, ...rest } = current;
      void removed;
      return rest;
    });
  }

  async function fetchCacheStatusForTable(requestAccess: AdminAccess, projectSlug: string, tableSlug: string) {
    setCacheStatusLoading(projectSlug, tableSlug, true);
    setCacheStatusError(projectSlug, tableSlug, null);

    try {
      const response = await getCacheStatus(requestAccess, projectSlug, tableSlug);
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
    setAccess(getDefaultAccess());
    setCacheStateByTable({});
    setCacheStatusErrorByTable({});
    setCacheStatusLoadingByTable({});
    setSpreadsheetTabsState({
      status: 'idle',
      message: 'Select a project to load spreadsheet tabs.'
    });
    setSpreadsheetWatchState({
      status: 'idle',
      message: 'Select a project to inspect spreadsheet watch status.'
    });
    setTabInspectionState({
      status: 'idle',
      message: 'Choose a sheet tab to preview its headers.'
    });
    setCreatedKey(null);
    setRefreshWarning(null);
    setDraftCredential('');
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
    setProjectSetupOpen(false);
    setTableSetupOpen(false);
    setAccessKeysOpen(false);
  }

  async function handleLoadScopedProject(projectSlug: string) {
    if (!access) return;
    const generationId = registryGeneration.begin();
    setProjectScopeEntry({ status: 'loading' });

    try {
      const detail = await getProject(access, projectSlug);
      if (!registryGeneration.isCurrent(generationId)) {
        return;
      }

      setProjectScopeSlug(projectSlug);
      setProjectScopeEntry({ status: 'idle' });
      setState({ status: 'ready', data: [summarizeProject(detail)] });
      setSelectedProjectSlug(projectSlug);
    } catch (error) {
      if (!registryGeneration.isCurrent(generationId)) {
        return;
      }

      // 401 is a rejected credential. 403 FORBIDDEN is a key that cannot access this project. Both stay on the slug prompt.
      const message = classifyAuthFailure(error) === null
        ? describeError(error)
        : `${error instanceof Error ? error.message : 'Unauthorized'} This key is not authorized for project ${projectSlug}: check the slug, and that the key is scoped to it with the admin:projects scope.`;
      setProjectScopeEntry({ status: 'error', message });
    }
  }

  async function handleCreateProject() {
    if (!access || !createProjectValidation.value) return;
    const input = createProjectValidation.value;

    await runMutation({
      label: `Saving project ${input.slug}`,
      mutate: () => createProject(access, input),
      commit: (detail) => {
        setCreateProjectDraft(initialCreateProjectDraft);
        setProjectSetupOpen(false);
        setState((current) =>
          current.status === 'ready'
            ? { status: 'ready', data: upsertBySlug(current.data, summarizeProject(detail)) }
            : current
        );
        setSelectedProjectSlug(input.slug);
      },
      refresh: () => refreshProjects(access)
    });
  }

  async function handleCreateTable() {
    if (!access || !selectedProjectSlug || !createTableValidation.value) return;
    const projectSlug = selectedProjectSlug;
    const input = createTableValidation.value;

    await runMutation({
      label: `Saving table ${projectSlug}/${input.tableSlug}`,
      mutate: () => createTable(access, projectSlug, input),
      commit: (result) => {
        const table = result.data;
        const isNewTable =
          projectDetailState.status === 'ready'
          && !projectDetailState.tables.some((candidate) => candidate.tableSlug === table.tableSlug);
        setCreateTableDraft(initialCreateTableDraft);
        setTableSetupOpen(false);
        setProjectDetailState((current) =>
          current.status === 'ready' && current.project.slug === projectSlug
            ? {
                ...current,
                tables: [...current.tables.filter((candidate) => candidate.tableSlug !== table.tableSlug), table]
              }
            : current
        );
        if (isNewTable) {
          setState((current) =>
            current.status === 'ready'
              ? {
                  status: 'ready',
                  data: current.data.map((project) =>
                    project.slug === projectSlug ? { ...project, tableCount: project.tableCount + 1 } : project
                  )
                }
              : current
          );
        }
      },
      refresh: async () => {
        await refreshProjects(access);
        await refreshProjectDetail(access, projectSlug);
      }
    });
  }

  async function handleCreateKey() {
    if (!access || !createKeyValidation.value) return;
    const validatedInput = createKeyValidation.value;
    const input = {
      name: validatedInput.name,
      scopes: validatedInput.scopes,
      ...(validatedInput.projectSlug !== undefined ? { projectSlug: validatedInput.projectSlug } : {})
    };
    const projectSlug = selectedProjectSlug;

    await runMutation({
      label: `Creating API key ${input.name}`,
      mutate: () => createApiKey(access, input),
      commit: (response) => {
        setCreatedKey(response.apiKey);
        if (response.record.projectSlug !== null && response.record.projectSlug === projectSlug) {
          setProjectKeysState((current) =>
            current.status === 'ready' ? { status: 'ready', data: [...current.data, response.record] } : current
          );
        }
        if (response.record.projectSlug === null) {
          setGlobalKeysState((current) =>
            current.status === 'ready' ? { status: 'ready', data: [...current.data, response.record] } : current
          );
        }
      },
      refresh: async () => {
        if (projectSlug) {
          await refreshProjectKeys(access, projectSlug);
        }
        if (!input.projectSlug && adminScope === 'global') {
          await refreshGlobalKeys(access);
        }
      }
    });
  }

  async function handleLoadCache(tableSlug: string) {
    if (!access || !selectedProjectSlug) return;
    await runAction(`Getting cache status for ${selectedProjectSlug}/${tableSlug}`, async () => {
      await fetchCacheStatusForTable(access, selectedProjectSlug, tableSlug);
    });
  }

  async function handleRefreshIfStale(tableSlug: string) {
    if (!access || !selectedProjectSlug) return;
    setCacheStatusLoading(selectedProjectSlug, tableSlug, true);
    setCacheStatusError(selectedProjectSlug, tableSlug, null);

    await runAction(`Refreshing cache for ${selectedProjectSlug}/${tableSlug} if stale`, async () => {
      try {
        const response = await refreshTableCache(access, selectedProjectSlug, tableSlug);
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
    if (!access || !selectedProjectSlug) return;
    setCacheStatusLoading(selectedProjectSlug, tableSlug, true);
    setCacheStatusError(selectedProjectSlug, tableSlug, null);

    await runAction(`Reindexing ${selectedProjectSlug}/${tableSlug}`, async () => {
      try {
        const response = await reindexTable(access, selectedProjectSlug, tableSlug);
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

  async function handleDeleteTable(tableSlug: string) {
    if (!access || !selectedProjectSlug) return;
    const projectSlug = selectedProjectSlug;
    const confirmed = window.confirm(`Delete table ${projectSlug}/${tableSlug}? This removes Sheetflare configuration and clears the local cache, but does not delete the Google Sheets tab.`);
    if (!confirmed) return;

    await runMutation({
      label: `Deleting table ${projectSlug}/${tableSlug}`,
      mutate: () => deleteTable(access, projectSlug, tableSlug),
      commit: () => {
        removeTableCacheEntries(getTableCacheKey(projectSlug, tableSlug));
        const existed =
          projectDetailState.status === 'ready'
          && projectDetailState.tables.some((candidate) => candidate.tableSlug === tableSlug);
        setProjectDetailState((current) =>
          current.status === 'ready' && current.project.slug === projectSlug
            ? { ...current, tables: current.tables.filter((candidate) => candidate.tableSlug !== tableSlug) }
            : current
        );
        if (existed) {
          setState((current) =>
            current.status === 'ready'
              ? {
                  status: 'ready',
                  data: current.data.map((project) =>
                    project.slug === projectSlug
                      ? { ...project, tableCount: Math.max(0, project.tableCount - 1) }
                      : project
                  )
                }
              : current
          );
        }
      },
      refresh: async () => {
        await refreshProjects(access);
        await refreshProjectDetail(access, projectSlug);
      }
    });
  }

  async function handleDeleteProject() {
    if (!access || !selectedProjectSlug || projectDetailState.status !== 'ready') return;
    const projectSlug = selectedProjectSlug;
    const tableCount = projectDetailState.tables.length;
    const confirmed = window.confirm(`Delete project ${projectSlug} and its ${tableCount} configured table${tableCount === 1 ? '' : 's'}? This does not delete the upstream Google spreadsheet.`);
    if (!confirmed) return;

    await runMutation({
      label: `Deleting project ${projectSlug}`,
      mutate: () => deleteProject(access, projectSlug),
      commit: () => {
        setCacheStateByTable({});
        setCacheStatusErrorByTable({});
        setCacheStatusLoadingByTable({});
        setProjectDetailState({
          status: 'idle',
          message: 'Select a project to inspect tables, cache state, and keys.'
        });
        setProjectKeysState({
          status: 'idle',
          message: 'Select a project to inspect and manage scoped API keys.'
        });
        setSpreadsheetWatchState({
          status: 'idle',
          message: 'Select a project to inspect spreadsheet watch status.'
        });

        if (projectScopeSlug !== null) {
          setProjectScopeSlug(null);
          setSelectedProjectSlug(null);
          setState({ status: 'scope-limited', message: projectKeyPromptMessage });
          return;
        }

        const remaining = state.status === 'ready'
          ? state.data.filter((project) => project.slug !== projectSlug)
          : [];
        setState({ status: 'ready', data: remaining });
        setSelectedProjectSlug(getSelectedProjectSlug(remaining, null));
      },
      ...(projectScopeSlug === null ? { refresh: () => refreshProjects(access) } : {})
    });
  }

  async function handleRevokeKey(apiKey: ApiKeyPrincipal) {
    if (!access) return;
    const confirmed = window.confirm(
      `Revoke API key "${apiKey.name}" (${apiKey.id})? Clients using it stop working immediately and this cannot be undone.`
    );
    if (!confirmed) return;
    const projectSlug = selectedProjectSlug;

    await runMutation({
      label: `Revoking key ${apiKey.id}`,
      mutate: () => revokeApiKey(access, apiKey.id),
      commit: () => {
        const revokedAt = new Date().toISOString();
        const markRevoked = (keys: ApiKeyPrincipal[]) =>
          keys.map((candidate) => (candidate.id === apiKey.id ? { ...candidate, revokedAt } : candidate));
        setCreatedKey((current) => (current?.startsWith(`sfk_${apiKey.id}.`) ? null : current));
        setProjectKeysState((current) =>
          current.status === 'ready' ? { status: 'ready', data: markRevoked(current.data) } : current
        );
        setGlobalKeysState((current) =>
          current.status === 'ready' ? { status: 'ready', data: markRevoked(current.data) } : current
        );
      },
      refresh: async () => {
        if (projectSlug) {
          await refreshProjectKeys(access, projectSlug);
        }
        if (adminScope === 'global') {
          await refreshGlobalKeys(access);
        }
      }
    });
  }

  async function handleRefreshProjects() {
    if (!access) return;
    setState({ status: 'loading' });
    await runAction('Refreshing project registry', async () => {
      try {
        await refreshProjects(access);
      } catch (error) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          authFailure: classifyAuthFailure(error)
        });
        throw error;
      }
    });
  }

  async function handleRefreshSelectedProject() {
    if (!access || !selectedProjectSlug) return;
    await runAction(`Refreshing project ${selectedProjectSlug}`, async () => {
      await refreshProjectDetail(access, selectedProjectSlug, { showLoading: true });
    });
  }

  async function handleRefreshProjectKeys() {
    if (!access || !selectedProjectSlug) return;
    await runAction(`Refreshing keys for ${selectedProjectSlug}`, async () => {
      await refreshProjectKeys(access, selectedProjectSlug, { showLoading: true });
    });
  }

  async function handleRefreshGlobalKeys() {
    if (!access) return;
    await runAction('Refreshing global admin keys', async () => {
      await refreshGlobalKeys(access, { showLoading: true });
    });
  }

  function handleSelectProject(projectSlug: string) {
    // Target-bound actions read the selected project when they commit; never switch under them.
    if (busyAction !== null) return;
    setSelectedProjectSlug(projectSlug);
    setProjectsExpanded(false);
  }

  const projectCount = state.status === 'ready' ? state.data.length : '...';
  const selectedProjectSummary =
    state.status === 'ready' && selectedProjectSlug
      ? state.data.find((project) => project.slug === selectedProjectSlug) ?? null
      : null;
  const projectHealthSummary =
    projectDetailState.status === 'ready'
      ? countTableHealth(
          projectDetailState.project.slug,
          projectDetailState.tables,
          cacheStateByTable,
          cacheStatusErrorByTable,
          cacheStatusLoadingByTable
        )
      : null;
  const credentialStatus = getCredentialStatus(access, serverCredentialState, state, adminScope);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloudflare Durable Objects + Google Sheets</p>
        <h1>Sheetflare Admin</h1>
        <p className="lede">
          Choose a project, inspect its tables, and use the tools you need when you need them.
        </p>
      </section>

      <CredentialPanel
        credentialStatus={credentialStatus}
        credentialSource={access?.source ?? null}
        projectScopeSlug={projectScopeSlug}
        draftCredential={draftCredential}
        onDraftCredentialChange={setDraftCredential}
        onSave={saveCredential}
        onClear={clearCredential}
        saveDisabled={draftCredential.trim().length === 0}
        clearDisabled={access?.source !== 'browser'}
        busy={busyAction !== null}
      />

      <NoticeBanner tone={notice.tone} message={notice.message} />
      <RefreshWarning
        message={refreshWarning?.message ?? null}
        onRetry={() => void handleRetryRefresh()}
        busy={busyAction !== null}
      />

      <section className="workspaceStack">
        <section className="panel projectPanel">
          <div className="panelHeader">
            <div>
              <h2>Projects</h2>
              <p className="muted compact">
                Choose a spreadsheet-backed project to inspect its tables, cache state, and access controls.
              </p>
            </div>
            <div className="actions compactHeaderActions">
              {selectedProjectSummary ? (
                <button
                  type="button"
                  className="secondaryButton"
                  onClick={() => setProjectsExpanded((current) => !current)}
                  disabled={busyAction !== null}
                >
                  {projectsExpanded ? 'Collapse projects' : 'Show projects'}
                </button>
              ) : null}
              <button
                type="button"
                className="secondaryButton"
                onClick={() => void handleRefreshProjects()}
                disabled={!access || busyAction !== null || state.status === 'scope-limited'}
              >
                Refresh projects
              </button>
              <span className="badge">{projectCount}</span>
            </div>
          </div>

          {state.status === 'idle' ? <p className="muted">{state.message}</p> : null}
          {state.status === 'loading' ? <p className="muted">Loading project registry...</p> : null}
          {state.status === 'error' ? (
            <div className="stack compactStack">
              <p className="error" role="alert">
                {state.message}
                {state.authFailure === 'invalid-credential' ? ' Update the credential and try again.' : ''}
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="secondaryButton"
                  onClick={() => void handleRefreshProjects()}
                  disabled={!access || busyAction !== null}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : null}
          {state.status === 'scope-limited' ? (
            <ProjectScopeEntry
              message={state.message}
              entryState={projectScopeEntry}
              onSubmit={(projectSlug) => void handleLoadScopedProject(projectSlug)}
              disabled={!access || busyAction !== null}
            />
          ) : null}
          {state.status === 'ready' && state.data.length === 0 ? (
            <div className="emptyState">
              <p className="muted">No projects yet. Add a project to connect your first spreadsheet.</p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => setProjectSetupOpen(true)}
                  disabled={!access || busyAction !== null}
                >
                  Add project
                </button>
              </div>
            </div>
          ) : null}
          {state.status === 'ready' && selectedProjectSummary && !projectsExpanded ? (
            <div className="projectPickerSummary">
              <div>
                <p className="sectionLabel">Current project</p>
                <p className="projectPickerName">{selectedProjectSummary.name}</p>
                <p className="muted compact">{selectedProjectSummary.slug}</p>
              </div>
              <span className="badge badgeMuted">{selectedProjectSummary.tableCount} tables</span>
            </div>
          ) : null}
          {state.status === 'ready' && state.data.length > 0 && projectsExpanded ? (
            <ProjectCards
              projects={state.data}
              selectedProjectSlug={selectedProjectSlug}
              onSelect={handleSelectProject}
              disabled={busyAction !== null}
            />
          ) : null}
        </section>

        <SelectedProjectPanel
          selectedProjectSlug={selectedProjectSlug}
          detailState={projectDetailState}
          projectHealthSummary={projectHealthSummary}
          createTableDraft={createTableDraft}
          tableFieldErrors={createTableValidation.fieldErrors}
          cacheStateByTable={cacheStateByTable}
          cacheStatusErrorByTable={cacheStatusErrorByTable}
          cacheStatusLoadingByTable={cacheStatusLoadingByTable}
          spreadsheetTabsState={spreadsheetTabsState}
          tabInspectionState={tabInspectionState}
          spreadsheetWatchState={spreadsheetWatchState}
          tableSetupOpen={tableSetupOpen}
          onTableSetupOpenChange={setTableSetupOpen}
          onCreateTableDraftChange={setCreateTableDraft}
          onCreateTable={() => void handleCreateTable()}
          onLoadCache={(tableSlug) => void handleLoadCache(tableSlug)}
          onRefreshIfStale={(tableSlug) => void handleRefreshIfStale(tableSlug)}
          onReindex={(tableSlug) => void handleReindex(tableSlug)}
          onDeleteTable={(tableSlug) => void handleDeleteTable(tableSlug)}
          onRefresh={() => void handleRefreshSelectedProject()}
          onDeleteProject={() => void handleDeleteProject()}
          busy={busyAction !== null}
          createTableDisabled={!access || !selectedProjectSlug || busyAction !== null || !createTableValidation.isValid}
          getTableCacheKey={getTableCacheKey}
        />
      </section>

      <section className="panel controlPanel">
        <div className="panelHeader">
          <div>
            <h2>Actions</h2>
            <p className="muted compact">Setup and access tools for changes that are less frequent.</p>
          </div>
        </div>

        <div className="stack">
          <details className="disclosureCard" open={projectSetupOpen} onToggle={(event) => setProjectSetupOpen((event.currentTarget as HTMLDetailsElement).open)}>
            <summary className="disclosureSummary">
              <div>
                <h3>Project setup</h3>
                <p className="muted compact">Create a new project and point it at a spreadsheet.</p>
              </div>
              <span className="badge badgeMuted">On demand</span>
            </summary>
            {adminScope === 'project' ? (
              <p className="muted">Creating projects requires a global admin key.</p>
            ) : (
              <CreateProjectForm
                draft={createProjectDraft}
                fieldErrors={createProjectValidation.fieldErrors}
                onChange={setCreateProjectDraft}
                onSubmit={() => void handleCreateProject()}
                submitDisabled={!access || busyAction !== null || !createProjectValidation.isValid}
              />
            )}
          </details>

          <details className="disclosureCard" open={accessKeysOpen} onToggle={(event) => setAccessKeysOpen((event.currentTarget as HTMLDetailsElement).open)}>
            <summary className="disclosureSummary">
              <div>
                <h3>Access keys</h3>
                <p className="muted compact">Create scoped keys, review global keys, and revoke old credentials.</p>
              </div>
              <span className="badge badgeMuted">Power tools</span>
            </summary>
            <ApiKeyPanel
              selectedProjectSlug={selectedProjectSlug}
              draft={createKeyDraft}
              fieldErrors={createKeyValidation.fieldErrors}
              onChange={setCreateKeyDraft}
              onSubmit={() => void handleCreateKey()}
              submitDisabled={!access || busyAction !== null || !createKeyValidation.isValid}
              createdKey={createdKey}
              projectKeysState={projectKeysState}
              globalKeysState={globalKeysState}
              busy={busyAction !== null}
              globalKeysAvailable={adminScope === 'global'}
              onRevoke={(apiKey) => void handleRevokeKey(apiKey)}
              onRefreshProjectKeys={() => void handleRefreshProjectKeys()}
              onRefreshGlobalKeys={() => void handleRefreshGlobalKeys()}
            />
          </details>
        </div>
      </section>
    </main>
  );
}
