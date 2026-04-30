import { describe, expect, it } from 'vitest';
import type { TableCacheStatus } from '@sheetflare/contracts';
import {
  buildCacheHealthEntry,
  buildCacheHealthReport,
  isCacheHealthy,
  renderCacheHealthMarkdown
} from './cache-health';

function createCacheStatus(overrides?: Partial<TableCacheStatus>): TableCacheStatus {
  return {
    status: 'ready',
    cacheTtlSeconds: 15,
    stale: false,
    staleReason: 'fresh',
    rowCount: 2,
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

describe('cache-health helpers', () => {
  it('marks validation drift as unhealthy', () => {
    expect(
      isCacheHealthy(
        createCacheStatus({
          validation: {
            status: 'warning',
            issueCount: 1,
            issues: [
              {
                rowId: 'row-2',
                rowNumber: 3,
                field: 'email',
                code: 'UNIQUE',
                message: 'email must be unique.'
              }
            ]
          }
        })
      )
    ).toBe(false);
  });

  it('marks pending external sheet changes as unhealthy until reindex completes', () => {
    expect(
      isCacheHealthy(
        createCacheStatus({
          stale: true,
          staleReason: 'external-change',
          externalChange: {
            pending: true,
            lastChangedAt: '2026-04-29T18:05:00.000Z',
            debounceUntil: '2026-04-29T18:05:30.000Z',
            lastAutoReindexAt: null
          }
        })
      )
    ).toBe(false);
  });

  it('builds report entries with validation state', () => {
    const entry = buildCacheHealthEntry(
      'demo',
      'users',
      createCacheStatus({
        validation: {
          status: 'warning',
          issueCount: 2,
          issues: []
        }
      })
    );

    expect(entry).toMatchObject({
      project: 'demo',
      table: 'users',
      validationStatus: 'warning',
      validationIssueCount: 2,
      healthy: false
    });
  });

  it('renders validation columns in markdown reports', () => {
    const report = buildCacheHealthReport('https://sheetflare.example', 'start', 'finish', [
      buildCacheHealthEntry('demo', 'users', createCacheStatus()),
      buildCacheHealthEntry(
        'demo',
        'drifted',
        createCacheStatus({
          validation: {
            status: 'warning',
            issueCount: 1,
            issues: []
          }
        })
      )
    ]);

    const markdown = renderCacheHealthMarkdown(report);
    expect(report.status).toBe('failed');
    expect(markdown).toContain('| Project | Table | Healthy | Status | Stale Reason | Validation | Issues | Row Count | Last Sync Error |');
    expect(markdown).toContain('| demo | drifted | no | ready | fresh | warning | 1 | 2 | none |');
  });
});
