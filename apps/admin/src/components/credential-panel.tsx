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
            Use a scoped admin API key for routine work. Bootstrap admin tokens are session-only and are not stored in the browser.
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
        <span>Remember this API key in this browser</span>
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
