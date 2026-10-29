import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { AdminErrorBoundary } from './components/error-boundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminErrorBoundary>
      <App />
    </AdminErrorBoundary>
  </StrictMode>
);
