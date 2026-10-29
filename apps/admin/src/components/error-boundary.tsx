import { Component, type ErrorInfo, type ReactNode } from 'react';

type AdminErrorBoundaryProps = {
  children: ReactNode;
};

type AdminErrorBoundaryState = {
  error: Error | null;
};

export class AdminErrorBoundary extends Component<AdminErrorBoundaryProps, AdminErrorBoundaryState> {
  override state: AdminErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Sheetflare Admin crashed while rendering.', error, info.componentStack);
  }

  private readonly handleRetry = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error === null) {
      return this.props.children;
    }

    return (
      <main className="shell">
        <section className="panel" role="alert">
          <h1>Sheetflare Admin hit an unexpected error</h1>
          <p className="error">{this.state.error.message}</p>
          <p className="muted">
            Your credential is only held in memory, so you may need to enter it again after reloading.
          </p>
          <div className="actions">
            <button type="button" onClick={this.handleRetry}>
              Try again
            </button>
            <button type="button" className="secondaryButton" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </main>
    );
  }
}
