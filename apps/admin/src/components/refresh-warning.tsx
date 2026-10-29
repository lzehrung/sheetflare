type RefreshWarningProps = {
  message: string | null;
  onRetry: () => void;
  busy: boolean;
};

export function RefreshWarning({ message, onRetry, busy }: RefreshWarningProps) {
  if (!message) {
    return null;
  }

  return (
    <div className="inlineNotice warningNotice" role="alert" data-testid="refresh-warning">
      <p className="warningTitle">{message}</p>
      <div className="actions">
        <button type="button" className="secondaryButton" onClick={onRetry} disabled={busy}>
          Retry refresh
        </button>
      </div>
    </div>
  );
}
