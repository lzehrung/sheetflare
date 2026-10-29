import {
  adminCreateApiKeyResultSchema,
  adminListApiKeysResultSchema,
  type AdminCreateApiKeyResult
} from '@sheetflare/contracts';
import type { BootstrapApiKey } from './bootstrap-config';
import { assertPresent, logStep, logSuccess, requestJson, ScriptError } from './runtime';

/** Same credential shape the gateway accepts, so rotation can recognize the key it is using. */
const apiKeyCredentialPattern = /^sfk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{64}$/;

export class BootstrapApiKeysError extends ScriptError {
  readonly result: BootstrapApiKeysResult;

  constructor(message: string, result: BootstrapApiKeysResult) {
    super(message);
    this.name = 'BootstrapApiKeysError';
    this.result = result;
  }
}

function authenticatingKeyId(credential: string) {
  return apiKeyCredentialPattern.exec(credential.trim())?.[1] ?? null;
}

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
 * Rotation revokes the old keys, so the replacements must reach the operator. `ops:bootstrap`
 * redacts secrets unless SHEETFLARE_SHOW_SECRETS is set; setup captures the full result itself
 * and hands it over. Refuse before issuing anything rather than strand the operator without keys.
 */
export function assertRotationCanHandOffKeys(options: {
  rotate: boolean;
  showSecrets: boolean;
  capturedBySetup: boolean;
}) {
  if (options.rotate && !options.showSecrets && !options.capturedBySetup) {
    throw new ScriptError(
      'Key rotation revokes the old keys and prints the replacements once. Set SHEETFLARE_SHOW_SECRETS=true so the new keys are not redacted, or rotate through npm run setup -- --bootstrap --rotate-keys.'
    );
  }
}

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
  try {
    await issueBootstrapApiKeys(options, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BootstrapApiKeysError(message, {
      created: [...result.created],
      skipped: [...result.skipped],
      revoked: [...result.revoked]
    });
  }
}

async function issueBootstrapApiKeys(
  options: {
    baseUrl: string;
    bearer: string;
    apiKeys: readonly BootstrapApiKey[];
    rotate: boolean;
  },
  result: BootstrapApiKeysResult
) {
  if (options.apiKeys.length === 0) {
    return;
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

  // Keyed by key id: a key matched by several configured entries is still revoked only once.
  const keysToRevoke = new Map<string, ManagedKeyRef>();
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

    for (const key of existing) {
      keysToRevoke.set(key.id, { name: key.name, id: key.id });
    }
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

  const currentKeyId = authenticatingKeyId(options.bearer);
  const revokeFirst: ManagedKeyRef[] = [];
  const revokeLast: ManagedKeyRef[] = [];
  for (const key of keysToRevoke.values()) {
    if (currentKeyId !== null && key.id === currentKeyId) {
      revokeLast.push(key);
    } else {
      revokeFirst.push(key);
    }
  }
  if (revokeLast.length > 0 && revokeFirst.length > 0) {
    logStep(
      `Leaving authenticating key ${revokeLast.map((key) => `${key.name} (${key.id})`).join(', ')} in place until the other revocations finish.`
    );
  }

  for (const key of [...revokeFirst, ...revokeLast]) {
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
}
