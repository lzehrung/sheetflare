import { useEffect, useState } from 'react';
import type {
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
  createApiKey,
  createProject,
  createTable,
  getCacheStatus,
  getProject,
  inspectSpreadsheetTab,
  listApiKeys,
  listProjects,
  listSpreadsheetWatches,
  listSpreadsheetTabs,
  refreshTableCache,
  revokeApiKey,
  reindexTable
} from './api';
import {
  canPersistAdminCredential,
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
    if (!credential || projectDetailState.status !== 'ready') {
      if (!credential || !selectedProjectSlug) {
        setSpreadsheetWatchState({
          status: 'idle',
          message: 'Select a project to inspect spreadsheet watch status.'
        });
      }
      return;
    }

    let cancelled = false;
    setSpreadsheetWatchState({ status: 'loading' });

    void (async () => {
      try {
        const result = await listSpreadsheetWatches(credential);
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
    credential,
    selectedProjectSlug,
    projectDetailState.status,
    projectDetailState.status === 'ready' ? projectDetailState.project.spreadsheetId : null
  ]);

  useEffect(() => {
    if (!credential || !selectedProjectSlug || projectDetailState.status !== 'ready' || !tableSetupOpen) {
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
        const result = await listSpreadsheetTabs(credential, selectedProjectSlug);
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
  }, [credential, selectedProjectSlug, projectDetailState.status, tableSetupOpen]);

  useEffect(() => {
    if (!credential || !selectedProjectSlug || !tableSetupOpen) {
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
        const result = await inspectSpreadsheetTab(credential, selectedProjectSlug, tabName, headerRow);
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
  }, [credential, selectedProjectSlug, createTableDraft.sheetTabName, createTableDraft.headerRow, tableSetupOpen]);

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
    const persistCredential = rememberCredential && canPersistAdminCredential(normalized);
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, persistCredential ? normalized : null);
    }

    setCredential(normalized);
    setCacheStateByTable({});
    setCreatedKey(null);
    setDraftCredential(normalized ?? '');
    setNotice(
      persistCredential || !normalized || !rememberCredential
        ? {
            tone: 'idle',
            message: null
          }
        : {
            tone: 'success',
            message: 'Only scoped admin API keys are stored in this browser. Bootstrap tokens stay session-only.'
          }
    );
    if (rememberCredential && !persistCredential) {
      setRememberCredential(false);
    }
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
    setProjectSetupOpen(false);
    setTableSetupOpen(false);
    setAccessKeysOpen(false);
  }

  async function handleCreateProject() {
    if (!credential || !createProjectValidation.value) return;
    const input = createProjectValidation.value;

    await runAction(`Saving project ${input.slug}`, async () => {
      await createProject(credential, input);
      setCreateProjectDraft(initialCreateProjectDraft);
      setProjectSetupOpen(false);
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
      setTableSetupOpen(false);
      await refreshProjects(credential);
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

  function handleSelectProject(projectSlug: string) {
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

      <NoticeBanner tone={notice.tone} message={notice.message} />

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
              <button type="button" className="secondaryButton" onClick={() => void handleRefreshProjects()} disabled={!credential || busyAction !== null}>
                Refresh projects
              </button>
              <span className="badge">{projectCount}</span>
            </div>
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
            <div className="emptyState">
              <p className="muted">No projects yet. Add a project to connect your first spreadsheet.</p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => setProjectSetupOpen(true)}
                  disabled={!credential || busyAction !== null}
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
          onRefresh={() => void handleRefreshSelectedProject()}
          busy={busyAction !== null}
          createTableDisabled={!credential || !selectedProjectSlug || busyAction !== null || !createTableValidation.isValid}
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
            <CreateProjectForm
              draft={createProjectDraft}
              fieldErrors={createProjectValidation.fieldErrors}
              onChange={setCreateProjectDraft}
              onSubmit={() => void handleCreateProject()}
              submitDisabled={!credential || busyAction !== null || !createProjectValidation.isValid}
            />
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
              submitDisabled={!credential || busyAction !== null || !createKeyValidation.isValid}
              createdKey={createdKey}
              projectKeysState={projectKeysState}
              globalKeysState={globalKeysState}
              busy={busyAction !== null}
              onRevoke={(apiKeyId) => void handleRevokeKey(apiKeyId)}
              onRefreshProjectKeys={() => void handleRefreshProjectKeys()}
              onRefreshGlobalKeys={() => void handleRefreshGlobalKeys()}
            />
          </details>
        </div>
      </section>
    </main>
  );
}
