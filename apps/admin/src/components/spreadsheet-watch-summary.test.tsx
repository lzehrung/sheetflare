// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SpreadsheetWatch } from '@sheetflare/contracts';
import { getSpreadsheetWatchStatusSummary, SpreadsheetWatchSummary } from './spreadsheet-watch-summary';

function createSpreadsheetWatch(overrides?: Partial<SpreadsheetWatch>): SpreadsheetWatch {
  return {
    spreadsheetId: 'sheet-1',
    googleCredentialRef: 'default',
    channelId: 'channel-sheet-1',
    resourceId: 'resource-sheet-1',
    resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
    expirationAt: '2026-05-03T00:00:00.000Z',
    lastWatchError: null,
    lastNotificationAt: '2026-04-26T00:00:00.000Z',
    pendingChangedAt: null,
    debounceUntil: null,
    lastReindexStartedAt: null,
    lastReindexCompletedAt: '2026-04-26T00:00:10.000Z',
    lastReindexError: null,
    projectSlugs: ['demo'],
    ...overrides
  };
}

describe('SpreadsheetWatchSummary', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('builds a shared one-line status summary', () => {
    expect(getSpreadsheetWatchStatusSummary(createSpreadsheetWatch())).toMatch(/^active \/ expires /i);
    expect(
      getSpreadsheetWatchStatusSummary(
        createSpreadsheetWatch({
          pendingChangedAt: '2026-04-26T00:01:00.000Z'
        })
      )
    ).toMatch(/^pending reindex \/ expires /i);
  });

  it('surfaces expired watches distinctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T00:00:00.000Z'));

    expect(getSpreadsheetWatchStatusSummary(createSpreadsheetWatch())).toMatch(/^expired \/ expires /i);
  });

  it('renders an active watch summary', () => {
    render(
      <dl>
        <SpreadsheetWatchSummary watch={createSpreadsheetWatch()} />
      </dl>
    );

    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
  });

  it('renders an explicit fallback when no projects are linked', () => {
    render(
      <dl>
        <SpreadsheetWatchSummary watch={createSpreadsheetWatch({ projectSlugs: [] })} />
      </dl>
    );

    expect(screen.getByText('None')).toBeTruthy();
  });

  it('renders pending and error details when present', () => {
    render(
      <dl>
        <SpreadsheetWatchSummary
          watch={createSpreadsheetWatch({
            pendingChangedAt: '2026-04-26T00:01:00.000Z',
            debounceUntil: '2026-04-26T00:01:30.000Z',
            lastWatchError: 'Renewal failed.'
          })}
        />
      </dl>
    );

    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('Pending Change')).toBeTruthy();
    expect(screen.getByText('Debounce Until')).toBeTruthy();
    expect(screen.getByText('Last Watch Error')).toBeTruthy();
    expect(screen.getByText('Renewal failed.')).toBeTruthy();
  });
});
