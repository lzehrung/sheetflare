// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SpreadsheetWatch } from '@sheetflare/contracts';
import { SpreadsheetWatchSummary } from './spreadsheet-watch-summary';

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
