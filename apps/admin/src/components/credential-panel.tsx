import type { FormEvent } from 'react';
import type { AdminAccess } from '../auth';

type CredentialPanelProps = {
  credentialStatus: 'required' | 'checking' | 'configured' | 'rejected' | 'error';
  credentialSource: AdminAccess['source'] | null;
  draftCredential: string;
  onDraftCredentialChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  saveDisabled: boolean;
  clearDisabled: boolean;
  busy: boolean;
};

function getCredentialBadgeLabel(status: CredentialPanelProps['credentialStatus']) {
  switch (status) {
    case 'required':
      return 'Required';
    case 'checking':
      return 'Checking';
    case 'configured':
      return 'Configured';
    case 'rejected':
      return 'Rejected';
    case 'error':
      return 'Error';
  }
}

function getCredentialSourceMessage(source: CredentialPanelProps['credentialSource']) {
  switch (source) {
    case 'local-server':
      return 'Using SHEETFLARE_ADMIN_CREDENTIAL from the local admin server. Enter another credential to override it for this session.';
    case 'browser':
      return 'Using the credential entered for this session.';
    case null:
      return 'Enter a scoped admin API key for this session.';
  }
}

export function CredentialPanel({
  credentialStatus,
  credentialSource,
  draftCredential,
  onDraftCredentialChange,
  onSave,
  onClear,
  saveDisabled,
  clearDisabled,
  busy
}: CredentialPanelProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saveDisabled && !busy) {
      onSave();
    }
  }

  return (
    <section className="panel authPanel">
      <div className="panelHeader">
        <div>
          <h2>Operator Access</h2>
          <p className="muted compact">{getCredentialSourceMessage(credentialSource)}</p>
        </div>
        <span className="badge">{getCredentialBadgeLabel(credentialStatus)}</span>
      </div>

      <form onSubmit={handleSubmit}>
        <input type="text" name="username" autoComplete="username" value="sheetflare-admin" readOnly hidden />
        <label className="field">
          <span>Admin credential</span>
          <input
            id="admin-credential"
            name="password"
            type="password"
            value={draftCredential}
            onChange={(event) => onDraftCredentialChange(event.target.value)}
            placeholder="sfk_... or bootstrap token"
            autoComplete="current-password"
            spellCheck={false}
          />
        </label>

        <div className="actions">
          <button type="submit" disabled={saveDisabled || busy}>
            Save and load
          </button>
          <button type="button" className="secondaryButton" onClick={onClear} disabled={clearDisabled || busy}>
            Clear
          </button>
        </div>
      </form>
    </section>
  );
}
