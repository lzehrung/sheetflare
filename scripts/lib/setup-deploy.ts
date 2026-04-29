import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getCommandName, runCommand } from './process';
import { ScriptError } from './runtime';

const apiWranglerConfigPath = resolve('apps/api/wrangler.jsonc');
const adminWranglerConfigPath = resolve('apps/admin/wrangler.jsonc');

type JsonObject = Record<string, unknown>;

function parseJsonConfig(text: string, path: string) {
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    throw new ScriptError(`Wrangler config ${path} must contain valid JSON for setup orchestration.`);
  }
}

async function withPatchedJsonFile<T>(
  path: string,
  patcher: (value: JsonObject) => JsonObject,
  action: () => Promise<T>
) {
  const originalText = await readFile(path, 'utf8');
  const originalValue = parseJsonConfig(originalText, path);
  const patchedText = `${JSON.stringify(patcher(originalValue), null, 2)}\n`;
  await writeFile(path, patchedText, 'utf8');
  try {
    return await action();
  } finally {
    await writeFile(path, originalText, 'utf8');
  }
}

function extractWorkersDevUrl(output: string) {
  const match = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi);
  if (!match || match.length === 0) {
    throw new ScriptError('API deploy did not report a workers.dev URL.');
  }

  return match[match.length - 1]!;
}

function extractPagesDeploymentUrl(output: string) {
  const match = output.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/gi);
  if (!match || match.length === 0) {
    throw new ScriptError('Admin deploy did not report a pages.dev URL.');
  }

  return match[match.length - 1]!;
}

function patchApiConfig(config: JsonObject, googleClientEmail: string) {
  const next = structuredClone(config);
  const vars = typeof next.vars === 'object' && next.vars !== null
    ? { ...(next.vars as Record<string, unknown>) }
    : {};
  vars.GOOGLE_CLIENT_EMAIL = googleClientEmail;
  next.vars = vars;
  return next;
}

function patchAdminConfig(config: JsonObject, apiBaseUrl: string) {
  const next = structuredClone(config);
  const vars = typeof next.vars === 'object' && next.vars !== null
    ? { ...(next.vars as Record<string, unknown>) }
    : {};
  vars.SHEETFLARE_API_BASE_URL = apiBaseUrl;
  next.vars = vars;
  return next;
}

export function buildApiDeployCommand() {
  return ['wrangler@4.85.0', 'deploy', '--config', 'wrangler.jsonc'];
}

export function buildAdminDeployCommand(projectName: string) {
  return ['wrangler@4.85.0', 'pages', 'deploy', 'dist', '--project-name', projectName, '--branch', 'main', '--commit-dirty=true'];
}

export async function deployApiWorker(googleClientEmail: string) {
  return withPatchedJsonFile(
    apiWranglerConfigPath,
    (config) => patchApiConfig(config, googleClientEmail),
    async () => {
      const result = await runCommand(
        getCommandName('npx'),
        buildApiDeployCommand(),
        {
          cwd: resolve('apps/api')
        }
      );
      if (result.code !== 0) {
        throw new ScriptError('API deploy failed.');
      }

      return {
        url: extractWorkersDevUrl(result.stdout),
        stdout: result.stdout
      };
    }
  );
}

export async function deployAdminPages(apiBaseUrl: string) {
  const projectName = getAdminPagesProjectName();
  return withPatchedJsonFile(
    adminWranglerConfigPath,
    (config) => patchAdminConfig(config, apiBaseUrl),
    async () => {
      const buildResult = await runCommand(
        getCommandName('npm'),
        ['run', 'build'],
        {
          cwd: resolve('apps/admin')
        }
      );
      if (buildResult.code !== 0) {
        throw new ScriptError('Admin build failed.');
      }

      const result = await runCommand(
        getCommandName('npx'),
        buildAdminDeployCommand(projectName),
        {
          cwd: resolve('apps/admin')
        }
      );
      if (result.code !== 0) {
        throw new ScriptError('Admin deploy failed.');
      }

      return {
        url: extractPagesDeploymentUrl(result.stdout),
        stdout: result.stdout
      };
    }
  );
}

export function getApiWranglerConfigPath() {
  return apiWranglerConfigPath;
}

export function getAdminPagesProjectName() {
  return 'sheetflare-admin';
}
