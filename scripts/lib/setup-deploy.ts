import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import * as ts from 'typescript';
import { getCommandName, runCommand } from './process';
import { ScriptError } from './runtime';

const apiWranglerConfigPath = resolve('apps/api/wrangler.jsonc');
const stagingApiWranglerConfigPath = resolve('apps/api/wrangler.staging.jsonc');

type JsonObject = Record<string, unknown>;
type PagesProjectListEntry = {
  name: string;
};

function normalizeSetupProfile(profile: string) {
  return profile.trim().toLowerCase();
}

function isStagingProfile(profile: string) {
  return normalizeSetupProfile(profile) === 'staging';
}

function parseJsonConfig(text: string, path: string) {
  let result: ReturnType<typeof ts.parseConfigFileTextToJson>;
  try {
    result = ts.parseConfigFileTextToJson(path, text);
  } catch {
    throw new ScriptError(`Wrangler config ${path} must contain valid JSONC for setup orchestration.`);
  }
  if (result.error) {
    throw new ScriptError(`Wrangler config ${path} must contain valid JSONC for setup orchestration.`);
  }

  if (typeof result.config !== 'object' || result.config === null || Array.isArray(result.config)) {
    throw new ScriptError(`Wrangler config ${path} must contain a JSON object for setup orchestration.`);
  }

  return result.config as JsonObject;
}

function createTempConfigPath(path: string) {
  const directory = dirname(path);
  const filename = basename(path, '.jsonc');
  return join(directory, `${filename}.setup-${randomUUID()}.jsonc`);
}

export async function withPatchedJsonConfig<T>(
  path: string,
  patcher: (value: JsonObject) => JsonObject,
  action: (tempConfigPath: string) => Promise<T>
) {
  const originalText = await readFile(path, 'utf8');
  const originalValue = parseJsonConfig(originalText, path);
  const tempConfigPath = createTempConfigPath(path);
  const patchedText = `${JSON.stringify(patcher(originalValue), null, 2)}\n`;
  await writeFile(tempConfigPath, patchedText, 'utf8');
  try {
    return await action(tempConfigPath);
  } finally {
    await rm(tempConfigPath, { force: true });
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

export function patchApiConfigForDeploy(config: JsonObject, googleClientEmail: string | null) {
  const next = structuredClone(config);
  const vars = typeof next.vars === 'object' && next.vars !== null
    ? { ...(next.vars as Record<string, unknown>) }
    : {};
  if (googleClientEmail) {
    vars.GOOGLE_CLIENT_EMAIL = googleClientEmail;
  } else {
    delete vars.GOOGLE_CLIENT_EMAIL;
  }
  next.vars = vars;
  return next;
}

export function parsePagesProjectList(output: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new ScriptError('Wrangler pages project list must return valid JSON.');
  }

  if (!Array.isArray(parsed)) {
    throw new ScriptError('Wrangler pages project list must return a JSON array.');
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      throw new ScriptError(`Wrangler pages project list entry ${index + 1} must include a non-empty name.`);
    }

    return {
      name: entry.name.trim()
    } satisfies PagesProjectListEntry;
  });
}

export async function listPagesProjects() {
  const result = await runCommand(
    getCommandName('npx'),
    buildPagesProjectListCommand(),
    {
      cwd: resolve('.'),
      echoStdout: false
    }
  );
  if (result.code !== 0) {
    throw new ScriptError('Failed to list Cloudflare Pages projects.');
  }

  return parsePagesProjectList(result.stdout);
}

export function buildApiDeployCommand(configPath: string) {
  return ['wrangler@4.85.0', 'deploy', '--config', configPath];
}

export function buildAdminDeployCommand(projectName: string) {
  return ['wrangler@4.85.0', 'pages', 'deploy', '--project-name', projectName, '--branch', 'main'];
}

export function buildPagesProjectListCommand() {
  return ['wrangler@4.85.0', 'pages', 'project', 'list', '--json'];
}

export function buildPagesProjectCreateCommand(projectName: string) {
  return ['wrangler@4.85.0', 'pages', 'project', 'create', projectName, '--production-branch', 'main'];
}

export async function deployApiWorker(profile: string, googleClientEmail: string | null) {
  return withPatchedJsonConfig(
    getApiWranglerConfigPath(profile),
    (config) => patchApiConfigForDeploy(config, googleClientEmail),
    async (tempConfigPath) => {
      const result = await runCommand(
        getCommandName('npx'),
        buildApiDeployCommand(tempConfigPath),
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

export async function ensurePagesProjectExists(projectName: string) {
  const existingProjects = await listPagesProjects();
  if (existingProjects.some((project) => project.name === projectName)) {
    return {
      created: false,
      projectName
    };
  }

  const result = await runCommand(
    getCommandName('npx'),
    buildPagesProjectCreateCommand(projectName),
    {
      cwd: resolve('.')
    }
  );
  if (result.code !== 0) {
    throw new ScriptError(`Failed to create Cloudflare Pages project ${projectName}.`);
  }

  return {
    created: true,
    projectName
  };
}

export async function deployAdminPages(profile: string) {
  const projectName = getAdminPagesProjectName(profile);
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
    deploymentUrl: extractPagesDeploymentUrl(result.stdout),
    siteUrl: getAdminPagesSiteUrl(projectName),
    stdout: result.stdout
  };
}

export function getApiWranglerConfigPath(profile = 'production') {
  return isStagingProfile(profile) ? stagingApiWranglerConfigPath : apiWranglerConfigPath;
}

export function getAdminPagesProjectName(profile = 'production') {
  return isStagingProfile(profile) ? 'sheetflare-staging-admin' : 'sheetflare-admin';
}

export function getAdminPagesSiteUrl(projectName = getAdminPagesProjectName()) {
  return `https://${projectName}.pages.dev`;
}
