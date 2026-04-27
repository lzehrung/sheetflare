import { setTimeout as delay } from 'node:timers/promises';
import { getEnv, logStep, logSuccess, ScriptError } from './lib/runtime';
import { getCommandName, killProcessTree, spawnCommand } from './lib/process';

async function waitForHttp(url: string, timeoutMs = 120_000) {
  const startedAt = Date.now();
  let lastError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}`.trim();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await delay(1000);
  }

  throw new ScriptError(`Timed out waiting for ${url}. ${lastError ? `Last error: ${lastError}` : ''}`.trim());
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawnCommand(command, args, { env });

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.on('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    child.on('error', reject);
  });

  if (code !== 0) {
    throw new ScriptError(
      `${[command, ...args].join(' ')} failed with ${code ?? signal ?? 'unknown exit state'}.`
    );
  }
}

async function main() {
  const apiPort = getEnv('SHEETFLARE_E2E_API_PORT') || '8787';
  const adminPort = getEnv('SHEETFLARE_E2E_ADMIN_PORT') || '4173';
  const apiHost = getEnv('SHEETFLARE_E2E_API_HOST') || '127.0.0.1';
  const adminHost = getEnv('SHEETFLARE_E2E_ADMIN_HOST') || '127.0.0.1';
  const apiBaseUrl = `http://${apiHost}:${apiPort}`;
  const adminUiUrl = `http://${adminHost}:${adminPort}`;
  const smokeEnv = {
    ...process.env,
    SHEETFLARE_BASE_URL: apiBaseUrl,
    SHEETFLARE_ADMIN_UI_URL: adminUiUrl,
    SHEETFLARE_API_BASE_URL: apiBaseUrl
  };

  const apiProcess = spawnCommand(
    getCommandName('npm'),
    ['--workspace', '@sheetflare/api', 'run', 'dev', '--', '--local', '--ip', apiHost, '--port', apiPort],
    { env: smokeEnv }
  );
  const adminProcess = spawnCommand(
    getCommandName('npm'),
    ['--workspace', '@sheetflare/admin', 'run', 'dev', '--', '--host', adminHost, '--port', adminPort],
    { env: smokeEnv }
  );

  try {
    logStep(`Wait for local API at ${apiBaseUrl}`);
    await waitForHttp(`${apiBaseUrl}/ready`);
    logSuccess('Local API is ready');

    logStep(`Wait for admin UI at ${adminUiUrl}`);
    await waitForHttp(adminUiUrl);
    logSuccess('Local admin UI is ready');

    logStep('Run local API smoke checks');
    await runCommand(getCommandName('npm'), ['run', 'smoke:staging'], smokeEnv);
    logSuccess('Local API smoke checks passed');

    logStep('Run admin browser checks');
    await runCommand(getCommandName('npm'), ['run', 'e2e:browser'], smokeEnv);
    logSuccess('Local admin browser checks passed');

    console.log('\n[done] local end-to-end checks passed');
  } finally {
    await killProcessTree(adminProcess.pid ?? NaN);
    await killProcessTree(apiProcess.pid ?? NaN);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ScriptError || error instanceof Error ? error.message : String(error);
  console.error(`\n[failed] ${message}`);
  process.exit(1);
});
