import { describe, expect, it } from 'vitest';
import { defaultMaxFullScanRows, getMaxFullScanRows } from '../src';

describe('getMaxFullScanRows', () => {
  it('returns the default when the env var is missing', () => {
    expect(getMaxFullScanRows({ TABLE_MAX_FULL_SCAN_ROWS: undefined })).toBe(defaultMaxFullScanRows);
  });

  it('accepts a positive integer override', () => {
    expect(getMaxFullScanRows({ TABLE_MAX_FULL_SCAN_ROWS: '2500' })).toBe(2500);
  });

  it('falls back to the default for invalid values', () => {
    expect(getMaxFullScanRows({ TABLE_MAX_FULL_SCAN_ROWS: '0' })).toBe(defaultMaxFullScanRows);
    expect(getMaxFullScanRows({ TABLE_MAX_FULL_SCAN_ROWS: '-5' })).toBe(defaultMaxFullScanRows);
    expect(getMaxFullScanRows({ TABLE_MAX_FULL_SCAN_ROWS: 'abc' })).toBe(defaultMaxFullScanRows);
  });
});
