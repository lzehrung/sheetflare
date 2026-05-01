import type { AdminListSpreadsheetWatchesResult, SpreadsheetWatch } from '@sheetflare/contracts';
import { requestJson } from './runtime';

export type DriveWatchRegistration = {
  spreadsheetId: string;
  channelId: string;
};

type DriveWatchRequestDependencies = {
  sleep?: (delayMs: number) => Promise<void>;
};

function defaultSleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function registerDriveWatches(options: {
  baseUrl: string;
  adminCredential: string;
  debounceSeconds?: number;
  expirationHours?: number;
}) {
  const response = await requestJson<{ data: DriveWatchRegistration[] }>({
    baseUrl: options.baseUrl,
    path: '/v1/admin/system/google/drive/watches/register',
    method: 'POST',
    bearer: options.adminCredential,
    body: {
      ...(options.debounceSeconds !== undefined ? { debounceSeconds: options.debounceSeconds } : {}),
      ...(options.expirationHours !== undefined ? { expirationHours: options.expirationHours } : {})
    },
    expectedStatus: 200
  });

  return response.data?.data ?? [];
}

export async function listDriveWatches(options: {
  baseUrl: string;
  adminCredential: string;
  retries?: number;
  retryDelayMs?: number;
}, dependencies: DriveWatchRequestDependencies = {}) {
  const retries = options.retries ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const sleep = dependencies.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await requestJson<AdminListSpreadsheetWatchesResult>({
      baseUrl: options.baseUrl,
      path: '/v1/admin/system/google/drive/watches',
      method: 'GET',
      bearer: options.adminCredential,
      expectedStatus: 200
    });
    const watches = response.data?.data ?? [];
    if (watches.length > 0 || attempt === retries) {
      return watches;
    }

    await sleep(retryDelayMs);
  }

  return [] satisfies SpreadsheetWatch[];
}
