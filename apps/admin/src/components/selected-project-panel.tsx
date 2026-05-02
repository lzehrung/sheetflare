import type { ProjectConfig, SpreadsheetTab, SpreadsheetWatch, TableCacheStatus, TableConfig } from '@sheetflare/contracts';
import type { CreateTableDraft } from '../admin-drafts';
import { CacheStatusSummary } from './cache-status-summary';
import { getSpreadsheetWatchStatusSummary, SpreadsheetWatchSummary } from './spreadsheet-watch-summary';

type ProjectDetailState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectConfig; tables: TableConfig[] }
  | { status: 'error'; message: string };

type SpreadsheetTabsState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: SpreadsheetTab[] }
  | { status: 'error'; message: string };

type TabInspectionState =
  | { status: 'idle'; message: string }
  | { status: 'loading'; tabName: string; headerRow: number }
  | { status: 'ready'; data: { tab: SpreadsheetTab; headerRow: number; headers: string[] } }
  | { status: 'error'; message: string; tabName: string; headerRow: number };

type SpreadsheetWatchState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; watch: SpreadsheetWatch | null }
  | { status: 'error'; message: string };

type ProjectHealthSummary = {
  healthy: number;
  stale: number;
  error: number;
  loading: number;
  pending: number;
};

type SelectedProjectPanelProps = {
  selectedProjectSlug: string | null;
  detailState: ProjectDetailState;
  projectHealthSummary: ProjectHealthSummary | null;
  createTableDraft: CreateTableDraft;
  tableFieldErrors: Partial<Record<keyof CreateTableDraft | 'form', string>>;
  cacheStateByTable: Record<string, TableCacheStatus | null>;
  cacheStatusErrorByTable: Record<string, string | null>;
  cacheStatusLoadingByTable: Record<string, boolean>;
  spreadsheetTabsState: SpreadsheetTabsState;
  tabInspectionState: TabInspectionState;
  spreadsheetWatchState: SpreadsheetWatchState;
  tableSetupOpen: boolean;
  onTableSetupOpenChange: (next: boolean) => void;
  onCreateTableDraftChange: (next: CreateTableDraft) => void;
  onCreateTable: () => void;
  onLoadCache: (tableSlug: string) => void;
  onRefreshIfStale: (tableSlug: string) => void;
  onReindex: (tableSlug: string) => void;
  onRefresh: () => void;
  busy: boolean;
  createTableDisabled: boolean;
  getTableCacheKey: (projectSlug: string, tableSlug: string) => string;
};

function renderFieldError(message: string | undefined) {
  return message ? <p className="fieldMessage error">{message}</p> : null;
}

function renderSpreadsheetWatchState(spreadsheetWatchState: SpreadsheetWatchState) {
  if (spreadsheetWatchState.status === 'loading') {
    return 'Loading watch status...';
  }

  if (spreadsheetWatchState.status === 'idle') {
    return spreadsheetWatchState.message;
  }

  if (spreadsheetWatchState.status === 'error') {
    return <span className="error">{spreadsheetWatchState.message}</span>;
  }

  if (spreadsheetWatchState.watch) {
    return (
      <>
        <span>{getSpreadsheetWatchStatusSummary(spreadsheetWatchState.watch)}</span>
        {spreadsheetWatchState.watch.lastWatchError ? (
          <p className="muted compact">
            Last watch issue: {spreadsheetWatchState.watch.lastWatchError}
          </p>
        ) : null}
      </>
    );
  }

  return 'No watch registered yet.';
}

function parseCsv(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readFieldRuleKeys(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }

    return Object.keys(parsed);
  } catch {
    return [];
  }
}

function renderValidationHints(draft: CreateTableDraft, tabInspectionState: TabInspectionState) {
  if (tabInspectionState.status !== 'ready') {
    return null;
  }

  const headers = new Set(tabInspectionState.data.headers);
  const hints: string[] = [];
  const idColumn = draft.idColumn.trim();
  if (idColumn && !headers.has(idColumn)) {
    hints.push(`ID column ${idColumn} is not present in the detected headers.`);
  }

  for (const field of parseCsv(draft.indexedFields)) {
    if (!headers.has(field)) {
      hints.push(`Indexed field ${field} is not present in the detected headers.`);
    }
  }

  for (const field of parseCsv(draft.readOnlyFields)) {
    if (!headers.has(field)) {
      hints.push(`Read-only field ${field} is not present in the detected headers.`);
    }
  }

  for (const field of readFieldRuleKeys(draft.fieldRulesJson)) {
    if (!headers.has(field)) {
      hints.push(`Field rule ${field} is not present in the detected headers.`);
    }
  }

  if (hints.length === 0) {
    return (
      <p className="success compact">
        Header row {tabInspectionState.data.headerRow} detected {tabInspectionState.data.headers.length} columns:
        {' '}
        <code>{tabInspectionState.data.headers.join(', ')}</code>
      </p>
    );
  }

  return (
    <div className="inlineNotice warningNotice">
      <p className="warningTitle">Check these fields before saving:</p>
      <ul className="warningList">
        {hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    </div>
  );
}

function renderSpreadsheetTabField(
  draft: CreateTableDraft,
  fieldError: string | undefined,
  spreadsheetTabsState: SpreadsheetTabsState,
  onChange: (next: CreateTableDraft) => void
) {
  if (spreadsheetTabsState.status === 'ready' && spreadsheetTabsState.data.length > 0) {
    const selectedTab = spreadsheetTabsState.data.find((tab) => tab.title === draft.sheetTabName) ?? null;
    return (
      <label className="field">
        <span>Sheet Tab</span>
        <select
          value={draft.sheetTabName}
          onChange={(event) => {
            const nextTabName = event.target.value;
            const matchedTab = spreadsheetTabsState.data.find((tab) => tab.title === nextTabName) ?? null;
            onChange({
              ...draft,
              sheetTabName: nextTabName,
              sheetGid: matchedTab ? String(matchedTab.sheetGid) : draft.sheetGid
            });
          }}
          aria-invalid={fieldError ? 'true' : 'false'}
        >
          <option value="">Select a tab</option>
          {spreadsheetTabsState.data.map((tab) => (
            <option key={tab.sheetGid} value={tab.title}>
              {tab.title}
            </option>
          ))}
        </select>
        <p className="fieldMessage muted">
          {selectedTab
            ? `Using existing tab ${selectedTab.title} with sheet id ${selectedTab.sheetGid}.`
            : `Choose from ${spreadsheetTabsState.data.length} discovered tabs.`}
        </p>
        {renderFieldError(fieldError)}
      </label>
    );
  }

  return (
    <label className="field">
      <span>Sheet Tab</span>
      <input
        value={draft.sheetTabName}
        onChange={(event) => onChange({ ...draft, sheetTabName: event.target.value })}
        aria-invalid={fieldError ? 'true' : 'false'}
      />
      <p className="fieldMessage muted">Use the existing tab name from Google Sheets, for example <code>Tasks</code>.</p>
      {renderFieldError(fieldError)}
    </label>
  );
}

export function SelectedProjectPanel({
  selectedProjectSlug,
  detailState,
  projectHealthSummary,
  createTableDraft,
  tableFieldErrors,
  cacheStateByTable,
  cacheStatusErrorByTable,
  cacheStatusLoadingByTable,
  spreadsheetTabsState,
  tabInspectionState,
  spreadsheetWatchState,
  tableSetupOpen,
  onTableSetupOpenChange,
  onCreateTableDraftChange,
  onCreateTable,
  onLoadCache,
  onRefreshIfStale,
  onReindex,
  onRefresh,
  busy,
  createTableDisabled,
  getTableCacheKey
}: SelectedProjectPanelProps) {
  const spreadsheetUrl =
    detailState.status === 'ready'
      ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(detailState.project.spreadsheetId)}/edit`
      : null;
  const apiDocsUrl = detailState.status === 'ready' ? '/docs' : null;

  return (
    <section className="panel mainPanel">
      <div className="panelHeader">
        <div>
          <h2>Project</h2>
          <p className="muted compact">{selectedProjectSlug ?? 'No project selected'}</p>
        </div>
        <div className="actions compactHeaderActions">
          <button
            type="button"
            className="secondaryButton"
            onClick={onRefresh}
            disabled={!selectedProjectSlug || busy}
          >
            Refresh project
          </button>
        </div>
      </div>

      {detailState.status === 'idle' ? <p className="muted">{detailState.message}</p> : null}
      {detailState.status === 'loading' ? <p className="muted">Loading project details...</p> : null}
      {detailState.status === 'error' ? <p className="error">{detailState.message}</p> : null}
      {detailState.status === 'ready' ? (
        <>
          <div className="projectOverview">
            <div className="projectOverviewHeader">
              <div>
                <h3>{detailState.project.name}</h3>
                <p className="muted compact">Review table status, cache state, and table settings.</p>
              </div>
              <div className="inlineBadges">
                <span className="badge">{detailState.tables.length} tables</span>
                <span className="badge badgeMuted">{detailState.project.defaultAuthMode}</span>
              </div>
            </div>
            <dl className="facts factsGrid compactFacts">
              <div>
                <dt>Spreadsheet</dt>
                <dd>
                  <span>{detailState.project.spreadsheetId}</span>{' '}
                  {spreadsheetUrl ? (
                    <a href={spreadsheetUrl} target="_blank" rel="noreferrer">
                      Open in Google Sheets
                    </a>
                  ) : null}
                  {apiDocsUrl ? (
                    <>
                      {' '}·{' '}
                      <a href={apiDocsUrl} target="_blank" rel="noreferrer">
                        Open API docs
                      </a>
                    </>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>Google Credential Ref</dt>
                <dd>{detailState.project.googleCredentialRef}</dd>
              </div>
              <div>
                <dt>Drive Watch</dt>
                <dd>
                  {renderSpreadsheetWatchState(spreadsheetWatchState)}
                </dd>
              </div>
            </dl>
            {projectHealthSummary ? (
              <div className="healthSummary">
                <span className="badge healthBadge">Healthy {projectHealthSummary.healthy}</span>
                <span className="badge badgeMuted">Stale {projectHealthSummary.stale}</span>
                <span className="badge badgeMuted">Table Errors {projectHealthSummary.error}</span>
                {projectHealthSummary.loading > 0 ? (
                  <span className="badge badgeMuted">Loading {projectHealthSummary.loading}</span>
                ) : null}
                {projectHealthSummary.pending > 0 ? (
                  <span className="badge badgeMuted">Pending {projectHealthSummary.pending}</span>
                ) : null}
              </div>
            ) : null}
          </div>

          {spreadsheetWatchState.status === 'ready' && spreadsheetWatchState.watch ? (
            <details className="disclosureCard subtleDisclosure compactDisclosure">
              <summary className="disclosureSummary">
                <div>
                  <h3>Spreadsheet Watch</h3>
                  <p className="muted compact">Drive webhook status, renewal timing, and automatic reindex diagnostics.</p>
                </div>
              </summary>
              <dl className="facts compactFacts">
                <SpreadsheetWatchSummary watch={spreadsheetWatchState.watch} />
              </dl>
            </details>
          ) : null}

          <details
            className="disclosureCard"
            open={tableSetupOpen}
            onToggle={(event) => onTableSetupOpenChange((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="disclosureSummary">
              <div>
                <h3>Connect Existing Tab</h3>
                <p className="muted compact">Choose an API resource name and connect it to an existing Google Sheets tab.</p>
              </div>
              <span className="badge badgeMuted">Optional</span>
            </summary>
            <div className="stack compactStack">
              {tableFieldErrors.form ? <p className="error">{tableFieldErrors.form}</p> : null}
              {spreadsheetTabsState.status === 'loading' ? <p className="muted compact">Loading spreadsheet tabs...</p> : null}
              {spreadsheetTabsState.status === 'error' ? <p className="error compact">{spreadsheetTabsState.message}</p> : null}
              <div className="formGrid">
                <label className="field">
                  <span>Table Entity</span>
                  <input
                    value={createTableDraft.tableSlug}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, tableSlug: event.target.value })}
                    aria-invalid={tableFieldErrors.tableSlug ? 'true' : 'false'}
                  />
                  <p className="fieldMessage muted">This is the API resource name, for example <code>tasks</code>.</p>
                  {renderFieldError(tableFieldErrors.tableSlug)}
                </label>
                {renderSpreadsheetTabField(
                  createTableDraft,
                  tableFieldErrors.sheetTabName,
                  spreadsheetTabsState,
                  onCreateTableDraftChange
                )}
                <label className="field">
                  <span>Sheet GID</span>
                  <input
                    value={createTableDraft.sheetGid}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, sheetGid: event.target.value })}
                    placeholder="Filled automatically when a tab is selected"
                    aria-invalid={tableFieldErrors.sheetGid ? 'true' : 'false'}
                  />
                  <p className="fieldMessage muted">The numeric sheet id is discovered from the selected tab when available.</p>
                  {renderFieldError(tableFieldErrors.sheetGid)}
                </label>
                <label className="field">
                  <span>ID Column</span>
                  <input
                    value={createTableDraft.idColumn}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, idColumn: event.target.value })}
                    aria-invalid={tableFieldErrors.idColumn ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.idColumn)}
                </label>
                <label className="field fieldSpanFull">
                  <span>Indexed Fields</span>
                  <input
                    value={createTableDraft.indexedFields}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, indexedFields: event.target.value })}
                    placeholder="Optional comma-separated columns"
                    aria-invalid={tableFieldErrors.indexedFields ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.indexedFields)}
                </label>
                <label className="field fieldSpanFull">
                  <span>Read-only Fields</span>
                  <input
                    value={createTableDraft.readOnlyFields}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, readOnlyFields: event.target.value })}
                    placeholder="Optional comma-separated columns"
                    aria-invalid={tableFieldErrors.readOnlyFields ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.readOnlyFields)}
                </label>
                <label className="field fieldSpanFull">
                  <span>Field Rules</span>
                  <textarea
                    value={createTableDraft.fieldRulesJson}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, fieldRulesJson: event.target.value })}
                    placeholder={'{"email":{"required":true,"unique":true,"normalize":["trim","lowercase"]},"status":{"enum":["pending","active"]},"score":{"type":"number"}}'}
                    aria-invalid={tableFieldErrors.fieldRulesJson ? 'true' : 'false'}
                    rows={6}
                  />
                  <p className="fieldMessage muted">Optional JSON object for required, unique, enum, normalize, and type rules.</p>
                  {renderFieldError(tableFieldErrors.fieldRulesJson)}
                </label>
                <label className="field">
                  <span>Header Row</span>
                  <input
                    value={createTableDraft.headerRow}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, headerRow: event.target.value })}
                    aria-invalid={tableFieldErrors.headerRow ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.headerRow)}
                </label>
                <label className="field">
                  <span>Data Start Row</span>
                  <input
                    value={createTableDraft.dataStartRow}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, dataStartRow: event.target.value })}
                    aria-invalid={tableFieldErrors.dataStartRow ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.dataStartRow)}
                </label>
                <label className="field">
                  <span>Cache TTL Seconds</span>
                  <input
                    value={createTableDraft.cacheTtlSeconds}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, cacheTtlSeconds: event.target.value })}
                    aria-invalid={tableFieldErrors.cacheTtlSeconds ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.cacheTtlSeconds)}
                </label>
              </div>
              {tabInspectionState.status === 'loading' ? (
                <p className="muted compact">
                  Reading header row {tabInspectionState.headerRow} from {tabInspectionState.tabName}...
                </p>
              ) : null}
              {tabInspectionState.status === 'error' ? (
                <p className="error compact">{tabInspectionState.message}</p>
              ) : null}
              {renderValidationHints(createTableDraft, tabInspectionState)}
              <div className="scopeGrid">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={createTableDraft.readEnabled}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, readEnabled: event.target.checked })}
                  />
                  <span>Read enabled</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={createTableDraft.createEnabled}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, createEnabled: event.target.checked })}
                  />
                  <span>Create enabled</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={createTableDraft.updateEnabled}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, updateEnabled: event.target.checked })}
                  />
                  <span>Update enabled</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={createTableDraft.deleteEnabled}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, deleteEnabled: event.target.checked })}
                  />
                  <span>Delete enabled</span>
                </label>
              </div>
              <div className="actions">
                <button type="button" onClick={onCreateTable} disabled={createTableDisabled}>
                  Save table
                </button>
              </div>
            </div>
          </details>

          {detailState.tables.length === 0 ? (
            <div className="emptyState">
              <p className="muted">No tables configured yet. Connect an existing tab to expose it through the API.</p>
              <div className="actions">
                <button type="button" onClick={() => onTableSetupOpenChange(true)} disabled={busy}>
                  Connect first tab
                </button>
              </div>
            </div>
          ) : null}
          {detailState.tables.length > 0 ? (
            <div className="cards">
              {detailState.tables.map((table) => {
                const cacheKey = getTableCacheKey(table.projectSlug, table.tableSlug);
                const cache = cacheStateByTable[cacheKey] ?? null;
                const cacheStatusError = cacheStatusErrorByTable[cacheKey] ?? null;
                const cacheStatusLoading = cacheStatusLoadingByTable[cacheKey] ?? false;
                const readOnlyFields = table.readOnlyFields ?? [];
                const constrainedFields = Object.keys(table.fieldRules ?? {});

                return (
                  <article key={table.tableSlug} className="card" data-testid={`table-card-${table.tableSlug}`}>
                    <div className="cardTop">
                      <div>
                        <p className="slug">{table.tableSlug}</p>
                        <h3>{table.sheetTabName}</h3>
                      </div>
                      <div className="inlineBadges">
                        <span className="badge">{table.cacheTtlSeconds}s TTL</span>
                        <span className={`badge${cache?.stale ? ' badgeMuted' : ''}`}>{cache ? cache.status : 'pending'}</span>
                      </div>
                    </div>

                    <dl className="facts compactFacts">
                      <div>
                        <dt>ID Column</dt>
                        <dd>{table.idColumn}</dd>
                      </div>
                      <div>
                        <dt>Indexes</dt>
                        <dd>{table.indexedFields.join(', ')}</dd>
                      </div>
                      <div>
                        <dt>Read-only</dt>
                        <dd>{readOnlyFields.length > 0 ? readOnlyFields.join(', ') : 'none'}</dd>
                      </div>
                      <div>
                        <dt>Rules</dt>
                        <dd>{constrainedFields.length > 0 ? constrainedFields.join(', ') : 'none'}</dd>
                      </div>
                      <div>
                        <dt>Write Access</dt>
                        <dd>
                          {table.createEnabled ? 'create' : 'create off'} / {table.updateEnabled ? 'update' : 'update off'} / {table.deleteEnabled ? 'delete' : 'delete off'}
                        </dd>
                      </div>
                      {!cache && cacheStatusLoading ? (
                        <div>
                          <dt>Cache</dt>
                          <dd>Loading cache status...</dd>
                        </div>
                      ) : null}
                      {!cache && !cacheStatusLoading && cacheStatusError ? (
                        <div>
                          <dt>Cache</dt>
                          <dd className="error">{cacheStatusError}</dd>
                        </div>
                      ) : null}
                      {!cache && !cacheStatusLoading && !cacheStatusError ? (
                        <div>
                          <dt>Cache</dt>
                          <dd>Cache status not loaded yet.</dd>
                        </div>
                      ) : null}
                      {cache ? (
                        <div>
                          <dt>Cache Summary</dt>
                          <dd>{cache.status} / {cache.staleReason} / {cache.rowCount} rows</dd>
                        </div>
                      ) : null}
                      {cache ? (
                        <div>
                          <dt>Validation</dt>
                          <dd>{cache.validation.status} / {cache.validation.issueCount} issues</dd>
                        </div>
                      ) : null}
                    </dl>

                    {cache ? (
                      <details className="disclosureCard subtleDisclosure compactDisclosure">
                        <summary className="disclosureSummary">
                          <div>
                            <h3>Diagnostics</h3>
                            <p className="muted compact">Timestamps, freshness, validation drift from the last full sync, and last sync error.</p>
                          </div>
                        </summary>
                        <dl className="facts compactFacts">
                          <CacheStatusSummary cache={cache} />
                        </dl>
                      </details>
                    ) : null}

                    <div className="actions compactActions">
                      <button type="button" onClick={() => onLoadCache(table.tableSlug)} disabled={busy}>
                        Get cache status
                      </button>
                      <button type="button" className="secondaryButton" onClick={() => onRefreshIfStale(table.tableSlug)} disabled={busy}>
                        Refresh if stale
                      </button>
                      <button type="button" className="secondaryButton" onClick={() => onReindex(table.tableSlug)} disabled={busy}>
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
  );
}
