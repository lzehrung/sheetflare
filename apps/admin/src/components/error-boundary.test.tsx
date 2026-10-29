// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AdminErrorBoundary } from './error-boundary';

let shouldThrow = true;

function Fragile() {
  if (shouldThrow) {
    throw new Error('Render exploded.');
  }

  return <p>Recovered content</p>;
}

describe('AdminErrorBoundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    shouldThrow = true;
  });

  it('replaces a crashed tree with an announced, recoverable error state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AdminErrorBoundary>
        <Fragile />
      </AdminErrorBoundary>
    );

    expect(screen.getByRole('alert').textContent).toContain('Render exploded.');

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered content')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
