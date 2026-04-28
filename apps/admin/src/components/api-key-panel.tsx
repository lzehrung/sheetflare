import type { ApiKeyPrincipal } from '@sheetflare/contracts';
import { allScopes, type CreateKeyDraft } from '../admin-drafts';
import { ApiKeySections } from './api-key-sections';

type LoadState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ApiKeyPrincipal[] }
  | { status: 'error'; message: string };

type GlobalKeysState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ApiKeyPrincipal[] }
  | { status: 'error'; message: string; unauthorized: boolean };

type ApiKeyPanelProps = {
  selectedProjectSlug: string | null;
  draft: CreateKeyDraft;
  fieldErrors: Partial<Record<'name' | 'projectScoped' | 'scopes' | 'form', string>>;
  onChange: (next: CreateKeyDraft) => void;
  onSubmit: () => void;
  submitDisabled: boolean;
  createdKey: string | null;
  projectKeysState: LoadState;
  globalKeysState: GlobalKeysState;
  busy: boolean;
  onRevoke: (apiKeyId: string) => void;
  onRefreshProjectKeys: () => void;
  onRefreshGlobalKeys: () => void;
};

function renderFieldError(message: string | undefined) {
  return message ? <p className="fieldMessage error">{message}</p> : null;
}

export function ApiKeyPanel({
  selectedProjectSlug,
  draft,
  fieldErrors,
  onChange,
  onSubmit,
  submitDisabled,
  createdKey,
  projectKeysState,
  globalKeysState,
  busy,
  onRevoke,
  onRefreshProjectKeys,
  onRefreshGlobalKeys
}: ApiKeyPanelProps) {
  return (
    <div className="stack compactStack">
      <div className="panelHeader">
        <h3>Create API Key</h3>
        <div className="actions compactHeaderActions">
          <button type="button" className="secondaryButton" onClick={onRefreshProjectKeys} disabled={!selectedProjectSlug || busy}>
            Refresh scoped keys
          </button>
          <button type="button" className="secondaryButton" onClick={onRefreshGlobalKeys} disabled={busy}>
            Refresh global keys
          </button>
        </div>
      </div>
      {fieldErrors.form ? <p className="error">{fieldErrors.form}</p> : null}
      <div className="formGrid">
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            aria-invalid={fieldErrors.name ? 'true' : 'false'}
          />
          {renderFieldError(fieldErrors.name)}
        </label>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={draft.projectScoped}
          onChange={(event) => onChange({ ...draft, projectScoped: event.target.checked })}
        />
        <span>Scope this key to the selected project</span>
      </label>
      {renderFieldError(fieldErrors.projectScoped)}
      <div className="scopeGrid">
        {allScopes.map((scope) => (
          <label key={scope} className="toggle">
            <input
              type="checkbox"
              checked={draft.scopes.includes(scope)}
              onChange={(event) => {
                onChange({
                  ...draft,
                  scopes: event.target.checked
                    ? [...draft.scopes, scope]
                    : draft.scopes.filter((entry) => entry !== scope)
                });
              }}
            />
            <span>{scope}</span>
          </label>
        ))}
      </div>
      {renderFieldError(fieldErrors.scopes)}
      <div className="actions">
        <button type="button" onClick={onSubmit} disabled={submitDisabled}>
          Create key
        </button>
      </div>
      {createdKey ? <p className="success">New key: <code>{createdKey}</code></p> : null}

      <details className="disclosureCard subtleDisclosure" open>
        <summary className="disclosureSummary">
          <div>
            <h3>Selected Project Keys</h3>
            <p className="muted compact">Keys scoped to the currently selected project.</p>
          </div>
        </summary>
        {projectKeysState.status === 'idle' ? <p className="muted">{projectKeysState.message}</p> : null}
        {projectKeysState.status === 'loading' ? <p className="muted">Loading scoped keys...</p> : null}
        {projectKeysState.status === 'error' ? <p className="error">{projectKeysState.message}</p> : null}
        {projectKeysState.status === 'ready' && projectKeysState.data.length > 0 ? (
          <ApiKeySections
            keys={projectKeysState.data}
            onRevoke={(apiKeyId) => onRevoke(apiKeyId)}
            busy={busy}
            emptyMessage="No scoped keys yet for this project."
          />
        ) : null}
        {projectKeysState.status === 'ready' && projectKeysState.data.length === 0 ? (
          <p className="muted">No scoped keys yet for this project.</p>
        ) : null}
      </details>

      <details className="disclosureCard subtleDisclosure">
        <summary className="disclosureSummary">
          <div>
            <h3>Global Admin Keys</h3>
            <p className="muted compact">Break-glass and cross-project credentials.</p>
          </div>
        </summary>
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
            onRevoke={(apiKeyId) => onRevoke(apiKeyId)}
            busy={busy}
            emptyMessage="No global admin keys yet."
          />
        ) : null}
      </details>
    </div>
  );
}
