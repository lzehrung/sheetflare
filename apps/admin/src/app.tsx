import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@sheetflare/contracts';
import {
  buildAdminHeaders,
  normalizeAdminCredential,
  readStoredAdminCredential,
  writeStoredAdminCredential
} from './auth';
import './styles.css';

type LoadState =
  | { status: 'idle'; message: string }
  | { status: 'loading' }
  | { status: 'ready'; data: ProjectSummary[] }
  | { status: 'error'; message: string; unauthorized: boolean };

function getInitialCredential() {
  if (typeof window === 'undefined') {
    return null;
  }

  return readStoredAdminCredential(window.localStorage);
}

export function App() {
  const [credential, setCredential] = useState<string | null>(() => getInitialCredential());
  const [draftCredential, setDraftCredential] = useState<string>(() => getInitialCredential() ?? '');
  const [state, setState] = useState<LoadState>(() =>
    getInitialCredential()
      ? { status: 'loading' }
      : {
          status: 'idle',
          message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
        }
  );

  useEffect(() => {
    if (!credential) {
      setState({
        status: 'idle',
        message: 'Enter a bootstrap admin token or scoped admin API key to load the control plane.'
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const headers = buildAdminHeaders(credential);
        const response = await fetch(
          '/v1/admin/projects',
          headers ? { headers } : undefined
        );

        if (response.status === 401) {
          throw new Error('The configured admin credential was rejected.');
        }

        if (!response.ok) {
          throw new Error(`Failed to load projects: ${response.status}`);
        }

        const body = (await response.json()) as { data: ProjectSummary[] };
        if (!cancelled) {
          setState({ status: 'ready', data: body.data });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          setState({
            status: 'error',
            message,
            unauthorized: message.includes('rejected')
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [credential]);

  function saveCredential() {
    const normalized = normalizeAdminCredential(draftCredential);
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, normalized);
    }

    setCredential(normalized);
    setDraftCredential(normalized ?? '');
  }

  function clearCredential() {
    if (typeof window !== 'undefined') {
      writeStoredAdminCredential(window.localStorage, null);
    }

    setCredential(null);
    setDraftCredential('');
  }

  const projectCount = state.status === 'ready' ? state.data.length : '...';

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloudflare Durable Objects + Google Sheets</p>
        <h1>Sheetflare Admin</h1>
        <p className="lede">
          A starter control plane for treating spreadsheet tabs like lightweight JSON tables.
        </p>
      </section>

      <section className="panel authPanel">
        <div className="panelHeader">
          <div>
            <h2>Operator Access</h2>
            <p className="muted compact">
              Use a bootstrap admin token or a scoped admin API key. The credential is stored locally in this browser.
            </p>
          </div>
          <span className="badge">{credential ? 'Configured' : 'Required'}</span>
        </div>

        <label className="field">
          <span>Admin credential</span>
          <input
            type="password"
            value={draftCredential}
            onChange={(event) => setDraftCredential(event.target.value)}
            placeholder="sfk_... or bootstrap token"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="actions">
          <button type="button" onClick={saveCredential}>
            Save and load
          </button>
          <button type="button" className="secondaryButton" onClick={clearCredential}>
            Clear
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Projects</h2>
          <span className="badge">{projectCount}</span>
        </div>

        {state.status === 'idle' ? <p className="muted">{state.message}</p> : null}
        {state.status === 'loading' ? <p className="muted">Loading project registry...</p> : null}
        {state.status === 'error' ? (
          <p className="error">
            {state.message}
            {state.unauthorized ? ' Update the stored credential and try again.' : ''}
          </p>
        ) : null}
        {state.status === 'ready' && state.data.length === 0 ? (
          <p className="muted">No projects yet. Create one through the admin API to get started.</p>
        ) : null}
        {state.status === 'ready' && state.data.length > 0 ? (
          <div className="cards">
            {state.data.map((project) => (
              <article key={project.slug} className="card">
                <div className="cardTop">
                  <div>
                    <p className="slug">{project.slug}</p>
                    <h3>{project.name}</h3>
                  </div>
                  <span className="badge">{project.tableCount} tables</span>
                </div>
                <dl className="facts">
                  <div>
                    <dt>Spreadsheet</dt>
                    <dd>{project.spreadsheetId}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
