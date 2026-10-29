import { BootstrapApiKeysError, type BootstrapApiKeysResult } from './bootstrap-keys';
import { bootstrapResultMarker, type SetupBootstrapOutput } from './setup-bootstrap';
import { redactSecret, ScriptError } from './runtime';

/**
 * Prints the bootstrap handoff, including keys created before a failure, then rethrows that failure.
 * Setup reads the marker from stdout even when the process exits non-zero.
 */
export async function finishBootstrapKeys(options: {
  projects: SetupBootstrapOutput['projects'];
  loadKeys: () => Promise<BootstrapApiKeysResult>;
  showSecrets: boolean;
  includeResultMarker: boolean;
  writeLine: (line: string) => void;
}) {
  const keyResult: BootstrapApiKeysResult = { created: [], skipped: [], revoked: [] };
  let failure: unknown = null;
  try {
    const loaded = await options.loadKeys();
    keyResult.created.push(...loaded.created);
    keyResult.skipped.push(...loaded.skipped);
    keyResult.revoked.push(...loaded.revoked);
  } catch (error) {
    failure = error;
    if (error instanceof BootstrapApiKeysError) {
      keyResult.created.push(...error.result.created);
      keyResult.skipped.push(...error.result.skipped);
      keyResult.revoked.push(...error.result.revoked);
    }
  }

  const output: SetupBootstrapOutput = {
    projects: options.projects,
    apiKeys: keyResult.created,
    skippedKeys: keyResult.skipped,
    revokedKeys: keyResult.revoked
  };

  options.writeLine(JSON.stringify({
    ...output,
    apiKeys: output.apiKeys.map((apiKey) => ({
      ...apiKey,
      apiKey: options.showSecrets ? apiKey.apiKey : redactSecret(apiKey.apiKey)
    }))
  }, null, 2));

  if (options.includeResultMarker) {
    options.writeLine(`${bootstrapResultMarker}${JSON.stringify(output)}`);
  }

  if (failure instanceof Error) {
    throw failure;
  }
  if (failure !== null && failure !== undefined) {
    throw new ScriptError(String(failure));
  }
}
