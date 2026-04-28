import type { ProjectConfig, TableCacheStatus, TableConfig } from '@sheetflare/contracts';
import type { CreateTableDraft } from '../admin-drafts';
import { CacheStatusSummary } from './cache-status-summary';

type ProjectDetailState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; project: ProjectConfig; tables: TableConfig[] }
  | { status: 'error'; message: string };

type SelectedProjectPanelProps = {
  selectedProjectSlug: string | null;
  detailState: ProjectDetailState;
  createTableDraft: CreateTableDraft;
  tableFieldErrors: Partial<Record<keyof CreateTableDraft | 'form', string>>;
  cacheStateByTable: Record<string, TableCacheStatus | null>;
  cacheStatusErrorByTable: Record<string, string | null>;
  cacheStatusLoadingByTable: Record<string, boolean>;
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

export function SelectedProjectPanel({
  selectedProjectSlug,
  detailState,
  createTableDraft,
  tableFieldErrors,
  cacheStateByTable,
  cacheStatusErrorByTable,
  cacheStatusLoadingByTable,
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

  return (
    <section className="panel mainPanel">
      <div className="panelHeader">
        <div>
          <h2>Selected Project</h2>
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
                <p className="muted compact">
                  Inspect table health first. Expand setup drawers only when you need to change structure.
                </p>
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
                </dd>
              </div>
              <div>
                <dt>Google Credential Ref</dt>
                <dd>{detailState.project.googleCredentialRef}</dd>
              </div>
            </dl>
          </div>

          <details className="disclosureCard">
            <summary className="disclosureSummary">
              <div>
                <h3>Create Table</h3>
                <p className="muted compact">
                  Add a new tab mapping and keep advanced options tucked into one form.
                </p>
              </div>
              <span className="badge badgeMuted">Optional</span>
            </summary>
            <div className="stack compactStack">
              {tableFieldErrors.form ? <p className="error">{tableFieldErrors.form}</p> : null}
              <div className="formGrid">
                <label className="field">
                  <span>Table Slug</span>
                  <input
                    value={createTableDraft.tableSlug}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, tableSlug: event.target.value })}
                    aria-invalid={tableFieldErrors.tableSlug ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.tableSlug)}
                </label>
                <label className="field">
                  <span>Sheet Tab</span>
                  <input
                    value={createTableDraft.sheetTabName}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, sheetTabName: event.target.value })}
                    aria-invalid={tableFieldErrors.sheetTabName ? 'true' : 'false'}
                  />
                  {renderFieldError(tableFieldErrors.sheetTabName)}
                </label>
                <label className="field">
                  <span>Sheet GID</span>
                  <input
                    value={createTableDraft.sheetGid}
                    onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, sheetGid: event.target.value })}
                    placeholder="Optional numeric sheet id"
                    aria-invalid={tableFieldErrors.sheetGid ? 'true' : 'false'}
                  />
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
            <p className="muted">No tables configured yet. Open Create Table when you are ready to add one.</p>
          ) : null}
          {detailState.tables.length > 0 ? (
            <div className="cards">
              {detailState.tables.map((table) => {
                const cacheKey = getTableCacheKey(table.projectSlug, table.tableSlug);
                const cache = cacheStateByTable[cacheKey] ?? null;
                const cacheStatusError = cacheStatusErrorByTable[cacheKey] ?? null;
                const cacheStatusLoading = cacheStatusLoadingByTable[cacheKey] ?? false;
                const readOnlyFields = table.readOnlyFields ?? [];

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
                    </dl>

                    {cache ? (
                      <details className="disclosureCard subtleDisclosure compactDisclosure">
                        <summary className="disclosureSummary">
                          <div>
                            <h3>Diagnostics</h3>
                            <p className="muted compact">Timestamps, freshness, and last sync error.</p>
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
