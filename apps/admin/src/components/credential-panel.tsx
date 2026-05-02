type CredentialPanelProps = {
  credentialStatus: 'required' | 'checking' | 'configured' | 'rejected' | 'error';
  draftCredential: string;
  onDraftCredentialChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
  saveDisabled: boolean;
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

export function CredentialPanel({
  credentialStatus,
  draftCredential,
  onDraftCredentialChange,
  onSave,
  onClear,
  saveDisabled,
  busy
}: CredentialPanelProps) {
  return (
    <section className="panel authPanel">
      <div className="panelHeader">
        <div>
          <h2>Operator Access</h2>
          <p className="muted compact">
            Use a scoped admin API key for routine work. Admin credentials are not stored in the browser.
          </p>
        </div>
        <span className="badge">{getCredentialBadgeLabel(credentialStatus)}</span>
      </div>

      <label className="field">
        <span>Admin credential</span>
        <input
          type="password"
          value={draftCredential}
          onChange={(event) => onDraftCredentialChange(event.target.value)}
          placeholder="sfk_... or bootstrap token"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="actions">
        <button type="button" onClick={onSave} disabled={saveDisabled || busy}>
          Save and load
        </button>
        <button type="button" className="secondaryButton" onClick={onClear} disabled={busy}>
          Clear
        </button>
      </div>
    </section>
  );
}
