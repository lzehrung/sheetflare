import { requestJson } from './runtime';

export type DriveWatchRegistration = {
  spreadsheetId: string;
  channelId: string;
};

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
