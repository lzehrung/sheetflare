type CredentialPanelProps = {
  credentialConfigured: boolean;
  draftCredential: string;
  rememberCredential: boolean;
  onDraftCredentialChange: (value: string) => void;
  onRememberCredentialChange: (value: boolean) => void;
  onSave: () => void;
  onClear: () => void;
  saveDisabled: boolean;
  busy: boolean;
};

export function CredentialPanel({
  credentialConfigured,
  draftCredential,
  rememberCredential,
  onDraftCredentialChange,
  onRememberCredentialChange,
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
            Use a bootstrap admin token or a scoped admin API key. The credential is only stored locally if you opt in below.
          </p>
        </div>
        <span className="badge">{credentialConfigured ? 'Configured' : 'Required'}</span>
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

      <label className="toggle">
        <input
          type="checkbox"
          checked={rememberCredential}
          onChange={(event) => onRememberCredentialChange(event.target.checked)}
        />
        <span>Remember this credential in this browser</span>
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
