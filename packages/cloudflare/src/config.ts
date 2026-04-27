import type { CloudflareEnv } from './types';

export const defaultMaxFullScanRows = 10_000;

export function getMaxFullScanRows(
  env: Pick<CloudflareEnv, 'TABLE_MAX_FULL_SCAN_ROWS'>
) {
  const parsed = Number.parseInt(env.TABLE_MAX_FULL_SCAN_ROWS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMaxFullScanRows;
}
