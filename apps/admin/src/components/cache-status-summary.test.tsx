// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TableCacheStatus } from '@sheetflare/contracts';
import { CacheStatusSummary } from './cache-status-summary';

function createCacheStatus(overrides?: Partial<TableCacheStatus>): TableCacheStatus {
  return {
    status: 'ready',
    cacheTtlSeconds: 15,
    stale: false,
    staleReason: 'fresh',
    rowCount: 3,
    lastSyncStartedAt: '2026-04-29T18:00:00.000Z',
    lastSyncCompletedAt: '2026-04-29T18:00:01.000Z',
    lastSyncError: null,
    validation: {
      status: 'ok',
      issueCount: 0,
      issues: []
    },
    externalChange: {
      pending: false,
      lastChangedAt: null,
      debounceUntil: null,
      lastAutoReindexAt: null
    },
    ...overrides
  };
}

describe('CacheStatusSummary', () => {
  it('renders validation status when the cache is clean', () => {
    render(
      <dl>
        <CacheStatusSummary cache={createCacheStatus()} />
      </dl>
    );

    expect(screen.getByText('Validation')).toBeTruthy();
    expect(screen.getByText('ok / 0 issues')).toBeTruthy();
  });

  it('renders validation issue details when drift is present', () => {
    render(
      <dl>
        <CacheStatusSummary
          cache={createCacheStatus({
            validation: {
              status: 'warning',
              issueCount: 2,
              issues: [
                {
                  rowId: 'row-2',
                  rowNumber: 3,
                  field: 'email',
                  code: 'UNIQUE',
                  message: 'email must be unique.'
                },
                {
                  rowId: 'row-4',
                  rowNumber: 5,
                  field: 'status',
                  code: 'REQUIRED',
                  message: 'status is required.'
                }
              ]
            }
          })}
        />
      </dl>
    );

    expect(screen.getByText('warning / 2 issues')).toBeTruthy();
    expect(screen.getByText(/row 3 \(row-2\) email UNIQUE: email must be unique\./)).toBeTruthy();
    expect(screen.getByText(/row 5 \(row-4\) status REQUIRED: status is required\./)).toBeTruthy();
  });
});
