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
  onCreateTableDraftChange: (next: CreateTableDraft) => void;
  onCreateTable: () => void;
  onLoadCache: (tableSlug: string) => void;
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
  onCreateTableDraftChange,
  onCreateTable,
  onLoadCache,
  onReindex,
  onRefresh,
  busy,
  createTableDisabled,
  getTableCacheKey
}: SelectedProjectPanelProps) {
  return (
    <section className="panel">
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
          <dl className="facts factsGrid">
            <div>
              <dt>Name</dt>
              <dd>{detailState.project.name}</dd>
            </div>
            <div>
              <dt>Spreadsheet</dt>
              <dd>{detailState.project.spreadsheetId}</dd>
            </div>
            <div>
              <dt>Default Auth</dt>
              <dd>{detailState.project.defaultAuthMode}</dd>
            </div>
            <div>
              <dt>Google Credential Ref</dt>
              <dd>{detailState.project.googleCredentialRef}</dd>
            </div>
          </dl>

          <div className="tableForm">
            <div className="panelHeader">
              <h3>Create Table</h3>
            </div>
            <div className="stack compactStack">
              {tableFieldErrors.form ? <p className="error">{tableFieldErrors.form}</p> : null}
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
              <label className="field">
                <span>Indexed Fields</span>
                <input
                  value={createTableDraft.indexedFields}
                  onChange={(event) => onCreateTableDraftChange({ ...createTableDraft, indexedFields: event.target.value })}
                  aria-invalid={tableFieldErrors.indexedFields ? 'true' : 'false'}
                />
                {renderFieldError(tableFieldErrors.indexedFields)}
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
          </div>

          {detailState.tables.length === 0 ? <p className="muted">No tables configured yet.</p> : null}
          {detailState.tables.length > 0 ? (
            <div className="cards">
              {detailState.tables.map((table) => {
                const cache = cacheStateByTable[getTableCacheKey(table.projectSlug, table.tableSlug)] ?? null;
                return (
                  <article key={table.tableSlug} className="card" data-testid={`table-card-${table.tableSlug}`}>
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
                      <div>
                        <dt>Write Access</dt>
                        <dd>
                          {table.createEnabled ? 'create' : 'create off'} / {table.updateEnabled ? 'update' : 'update off'} / {table.deleteEnabled ? 'delete' : 'delete off'}
                        </dd>
                      </div>
                      {cache ? <CacheStatusSummary cache={cache} /> : null}
                    </dl>
                    <div className="actions compactActions">
                      <button type="button" onClick={() => onLoadCache(table.tableSlug)} disabled={busy}>
                        Load cache
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
