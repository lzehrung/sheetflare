import type { ApiKeyPrincipal } from '@sheetflare/contracts';

type ApiKeySectionsProps = {
  keys: ApiKeyPrincipal[];
  onRevoke: (apiKeyId: string) => void;
  busy: boolean;
  emptyMessage: string;
  title?: string;
};

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Never';
}

type ApiKeyCardProps = {
  apiKey: ApiKeyPrincipal;
  onRevoke: (apiKeyId: string) => void;
  busy: boolean;
};

function ApiKeyCard({ apiKey, onRevoke, busy }: ApiKeyCardProps) {
  const revoked = apiKey.revokedAt !== null;

  return (
    <article className="card" data-testid={`api-key-card-${apiKey.id}`}>
      <div className="cardTop">
        <div>
          <p className="slug">{apiKey.id}</p>
          <h3>{apiKey.name}</h3>
        </div>
        <span className={`badge${revoked ? ' badgeMuted' : ''}`}>{revoked ? 'Revoked' : 'Active'}</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Scopes</dt>
          <dd>{apiKey.scopes.join(', ')}</dd>
        </div>
        <div>
          <dt>Last Used</dt>
          <dd>{formatTimestamp(apiKey.lastUsedAt)}</dd>
        </div>
        <div>
          <dt>Revoked At</dt>
          <dd>{formatTimestamp(apiKey.revokedAt)}</dd>
        </div>
      </dl>
      <div className="actions compactActions">
        <button
          type="button"
          className="secondaryButton"
          onClick={() => onRevoke(apiKey.id)}
          disabled={busy || revoked}
        >
          {revoked ? 'Revoked' : 'Revoke'}
        </button>
      </div>
    </article>
  );
}

export function ApiKeySections({
  keys,
  onRevoke,
  busy,
  emptyMessage,
  title
}: ApiKeySectionsProps) {
  const activeKeys = keys.filter((apiKey) => apiKey.revokedAt === null);
  const revokedKeys = keys.filter((apiKey) => apiKey.revokedAt !== null);

  if (keys.length === 0) {
    return <p className="muted">{emptyMessage}</p>;
  }

  return (
    <div className="stack">
      {title ? <h3>{title}</h3> : null}
      {activeKeys.length > 0 ? (
        <div className="stack compactStack">
          <p className="muted sectionLabel">Active Keys</p>
          <div className="cards">
            {activeKeys.map((apiKey) => (
              <ApiKeyCard key={apiKey.id} apiKey={apiKey} onRevoke={onRevoke} busy={busy} />
            ))}
          </div>
        </div>
      ) : null}
      {revokedKeys.length > 0 ? (
        <div className="stack compactStack">
          <p className="muted sectionLabel">Revoked Keys</p>
          <div className="cards">
            {revokedKeys.map((apiKey) => (
              <ApiKeyCard key={apiKey.id} apiKey={apiKey} onRevoke={onRevoke} busy={busy} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
