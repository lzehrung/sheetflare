import type {
  AdminListSpreadsheetWatchRetryAdviceResult,
  AdminListSpreadsheetWatchesResult,
  SpreadsheetWatch,
  SpreadsheetWatchRetryAdvice
} from '@sheetflare/contracts';
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

export type DriveWatchRegistrationPlan =
  | { kind: 'register' }
  | { kind: 'warn'; message: string }
  | { kind: 'skip' };

/**
 * Decides whether a setup run must (re)register Drive watches.
 *
 * Deploy and bootstrap register watches. Applying secrets without them is also a trigger because
 * it can replace GOOGLE_DRIVE_WEBHOOK_SECRET, and existing Drive channels keep the old token, so
 * the Worker rejects their notifications until watches are registered again.
 */
export function planDriveWatchRegistration(options: {
  actions: { applySecretsNow: boolean; deployNow: boolean; bootstrapNow: boolean };
  apiUrl: string | null;
  adminCredential: string | null;
}): DriveWatchRegistrationPlan {
  const { actions, apiUrl, adminCredential } = options;
  if (actions.deployNow || actions.bootstrapNow) {
    return apiUrl && adminCredential ? { kind: 'register' } : { kind: 'skip' };
  }

  if (!actions.applySecretsNow) {
    return { kind: 'skip' };
  }

  if (apiUrl && adminCredential) {
    return { kind: 'register' };
  }

  const missing = [
    ...(apiUrl ? [] : ['SHEETFLARE_BASE_URL (the deployed API URL)']),
    ...(adminCredential ? [] : ['SHEETFLARE_ADMIN_CREDENTIAL (an admin API key or the bootstrap token)'])
  ].join(' and ');
  return {
    kind: 'warn',
    message: `Applying secrets may have replaced the Drive webhook secret. Existing Google Drive watches still carry the old token, so the Worker rejects their notifications and automatic reindexing stops until watches are registered again. Setup could not do that because ${missing} is not set. Set it, then run: npm run ops:watch:drive`
  };
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

export async function listDriveWatchRetryAdvice(options: {
  baseUrl: string;
  adminCredential: string;
}) {
  const response = await requestJson<AdminListSpreadsheetWatchRetryAdviceResult>({
    baseUrl: options.baseUrl,
    path: '/v1/admin/system/google/drive/watches/retry-advice',
    method: 'GET',
    bearer: options.adminCredential,
    expectedStatus: 200
  });

  return response.data?.data ?? ([] satisfies SpreadsheetWatchRetryAdvice[]);
}
