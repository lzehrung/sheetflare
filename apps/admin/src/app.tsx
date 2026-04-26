import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@sheetflare/contracts';
import './styles.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: ProjectSummary[] }
  | { status: 'error'; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/v1/admin/projects');
        if (!response.ok) {
          throw new Error(`Failed to load projects: ${response.status}`);
        }

        const body = (await response.json()) as { data: ProjectSummary[] };
        if (!cancelled) {
          setState({ status: 'ready', data: body.data });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cloudflare Durable Objects + Google Sheets</p>
        <h1>Sheetflare Admin</h1>
        <p className="lede">
          A starter control plane for treating spreadsheet tabs like lightweight JSON tables.
        </p>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <h2>Projects</h2>
          <span className="badge">{state.status === 'ready' ? state.data.length : '...'}</span>
        </div>

        {state.status === 'loading' ? <p className="muted">Loading project registry...</p> : null}
        {state.status === 'error' ? <p className="error">{state.message}</p> : null}
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
