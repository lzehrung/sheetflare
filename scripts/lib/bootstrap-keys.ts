import {
  adminCreateApiKeyResultSchema,
  adminListApiKeysResultSchema,
  type AdminCreateApiKeyResult
} from '@sheetflare/contracts';
import type { BootstrapApiKey } from './bootstrap-config';
import { assertPresent, logStep, logSuccess, requestJson } from './runtime';

export type ManagedKeyRef = {
  name: string;
  id: string;
};

export type BootstrapApiKeysResult = {
  created: AdminCreateApiKeyResult[];
  /** Keys whose name already had an active key, left untouched because rotation was not requested. */
  skipped: ManagedKeyRef[];
  /** Prior active keys revoked after their replacements were issued (rotate mode only). */
  revoked: ManagedKeyRef[];
};

/**
 * Creates the configured API keys through the existing admin routes.
 *
 * Key names are not unique server-side and creation always inserts, so a blind rerun would stack
 * another set of privileged keys. By default a name that already has an active key is skipped.
 * With `rotate`, replacements are created first and the prior active keys with those names are
 * revoked afterwards, so a key that is itself authenticating this run is only revoked at the end.
 */
export async function bootstrapApiKeys(options: {
  baseUrl: string;
  bearer: string;
  apiKeys: readonly BootstrapApiKey[];
  rotate: boolean;
}): Promise<BootstrapApiKeysResult> {
  const result: BootstrapApiKeysResult = { created: [], skipped: [], revoked: [] };
  if (options.apiKeys.length === 0) {
    return result;
  }

  const listResponse = await requestJson<unknown>({
    baseUrl: options.baseUrl,
    path: '/v1/admin/keys',
    bearer: options.bearer,
    expectedStatus: 200
  });
  const activeKeys = adminListApiKeysResultSchema
    .parse(assertPresent(listResponse.data, 'API key listing returned an empty response body.'))
    .data
    .filter((key) => key.revokedAt === null);

  const keysToRevoke: ManagedKeyRef[] = [];
  for (const apiKey of options.apiKeys) {
    const existing = activeKeys.filter((key) => key.name === apiKey.name);
    const [firstExisting] = existing;
    if (firstExisting && !options.rotate) {
      result.skipped.push({ name: apiKey.name, id: firstExisting.id });
      logSuccess(
        `Key ${apiKey.name} already active (${firstExisting.id}); skipped. Secrets cannot be re-read: supply the existing key, or rerun with SHEETFLARE_BOOTSTRAP_ROTATE_KEYS=true (setup: --rotate-keys) to issue a replacement and revoke it.`
      );
      continue;
    }

    keysToRevoke.push(...existing.map((key) => ({ name: key.name, id: key.id })));
    logStep(`Creating key ${apiKey.name}`);
    const createResponse = await requestJson<unknown>({
      baseUrl: options.baseUrl,
      path: '/v1/admin/keys',
      method: 'POST',
      bearer: options.bearer,
      expectedStatus: 201,
      body: apiKey
    });
    const createdKey = adminCreateApiKeyResultSchema.parse(
      assertPresent(createResponse.data, 'API key creation returned an empty response body.')
    );
    result.created.push(createdKey);
    logSuccess(`Key created: ${createdKey.record.id}`);
  }

  for (const key of keysToRevoke) {
    logStep(`Revoking replaced key ${key.name} (${key.id})`);
    await requestJson<unknown>({
      baseUrl: options.baseUrl,
      path: `/v1/admin/keys/${encodeURIComponent(key.id)}`,
      method: 'DELETE',
      bearer: options.bearer,
      expectedStatus: 200
    });
    result.revoked.push(key);
    logSuccess(`Key revoked: ${key.id}`);
  }

  return result;
}
