import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCommandName, runCommand } from './process';
import { ScriptError } from './runtime';

const execFileAsync = promisify(execFile);
const requiredGoogleApis = [
  'sheets.googleapis.com',
  'drive.googleapis.com'
] as const;
const placeholderGoogleClientEmail = 'service-account@your-gcp-project.iam.gserviceaccount.com';

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type GcloudDependencies = {
  commandRunner?: (command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    echoStdout?: boolean;
    echoStderr?: boolean;
  }) => Promise<CommandResult>;
  sleep?: (ms: number) => Promise<void>;
  tempDirFactory?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  removePath?: (path: string) => Promise<void>;
  pythonExecutableResolver?: () => Promise<string | null>;
};

type ServiceAccountKeyJson = {
  client_email: string;
  private_key: string;
};

function normalizeProfile(profile: string) {
  return profile.trim().toLowerCase();
}

export function isPlaceholderGoogleClientEmail(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  return value.trim().toLowerCase() === placeholderGoogleClientEmail;
}

export function getDefaultGoogleProjectId(profile: string) {
  const normalizedProfile = normalizeProfile(profile);
  if (normalizedProfile === 'prod' || normalizedProfile === 'production') {
    return 'sheetflare-prod';
  }

  if (normalizedProfile === 'staging') {
    return 'sheetflare-staging';
  }

  return `sheetflare-${normalizedProfile}`;
}

export function getDefaultGoogleServiceAccountName(profile: string) {
  return getDefaultGoogleProjectId(profile);
}

export function normalizeGoogleProjectId(value: string) {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) {
    throw new ScriptError('Google Cloud project ID must start with a letter, use lowercase letters, numbers, or hyphens, and be 6-30 characters long.');
  }

  return trimmed;
}

export function normalizeGoogleServiceAccountName(value: string) {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) {
    throw new ScriptError('Google service-account name must start with a letter, use lowercase letters, numbers, or hyphens, and be 6-30 characters long.');
  }

  return trimmed;
}

export function createGoogleServiceAccountEmail(projectId: string, serviceAccountName: string) {
  return `${serviceAccountName}@${projectId}.iam.gserviceaccount.com`;
}

export function createGoogleServiceAccountDisplayName(profile: string) {
  const normalizedProfile = normalizeProfile(profile);
  const displayProfile = normalizedProfile.length > 0
    ? normalizedProfile.charAt(0).toUpperCase() + normalizedProfile.slice(1)
    : 'Default';
  return `Sheetflare ${displayProfile}`;
}

async function defaultPythonExecutableResolver() {
  try {
    const result = await execFileAsync('python', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const executable = result.stdout.trim();
    return executable.length > 0 ? executable : null;
  } catch {
    return null;
  }
}

async function createGcloudEnvironment(dependencies: GcloudDependencies = {}) {
  if (process.env.CLOUDSDK_PYTHON?.trim()) {
    return {
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1'
    } satisfies NodeJS.ProcessEnv;
  }

  const pythonExecutableResolver = dependencies.pythonExecutableResolver ?? defaultPythonExecutableResolver;
  const pythonExecutable = await pythonExecutableResolver();
  if (!pythonExecutable) {
    return {
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1'
    } satisfies NodeJS.ProcessEnv;
  }

  return {
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    CLOUDSDK_PYTHON: pythonExecutable
  } satisfies NodeJS.ProcessEnv;
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    echoStdout?: boolean;
    echoStderr?: boolean;
  }
) {
  return runCommand(command, args, options);
}

async function runGcloudCommand(
  args: string[],
  dependencies: GcloudDependencies = {},
  options?: {
    echoStdout?: boolean;
    echoStderr?: boolean;
  }
) {
  const commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
  const gcloudEnv = await createGcloudEnvironment(dependencies);
  return commandRunner(getCommandName('gcloud'), args, {
    env: gcloudEnv,
    ...(options?.echoStdout !== undefined ? { echoStdout: options.echoStdout } : {}),
    ...(options?.echoStderr !== undefined ? { echoStderr: options.echoStderr } : {})
  });
}

function parseLineList(value: string) {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function validateServiceAccountKeyJson(path: string, text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ScriptError(`Generated service-account key file ${path} was not valid JSON.`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('client_email' in parsed) ||
    !('private_key' in parsed) ||
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string' ||
    parsed.client_email.trim().length === 0 ||
    parsed.private_key.trim().length === 0
  ) {
    throw new ScriptError(`Generated service-account key file ${path} must include non-empty client_email and private_key fields.`);
  }

  return parsed as ServiceAccountKeyJson;
}

async function waitForServiceAccountVisibility(
  projectId: string,
  serviceAccountEmail: string,
  dependencies: GcloudDependencies
) {
  const sleep = dependencies.sleep ?? (async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const listResult = await runGcloudCommand(
      ['iam', 'service-accounts', 'list', '--project', projectId, '--format=value(email)'],
      dependencies,
      {
        echoStdout: false,
        echoStderr: false
      }
    );
    if (listResult.code === 0) {
      const emails = new Set(parseLineList(listResult.stdout));
      if (emails.has(serviceAccountEmail)) {
        return;
      }
    }

    if (attempt < 5) {
      await sleep(5000);
    }
  }

  throw new ScriptError(`Google service account ${serviceAccountEmail} was created but did not become visible in time.`);
}

export async function checkGcloudAuthPrereq(dependencies: GcloudDependencies = {}) {
  const result = await runGcloudCommand(
    ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
    dependencies,
    {
      echoStdout: false,
      echoStderr: false
    }
  );

  if (result.code === 0 && result.stdout.trim().length > 0) {
    return {
      name: 'gcloud auth',
      status: 'ready',
      summary: 'Google Cloud authentication is available for setup provisioning.',
      remediation: null
    } as const;
  }

  if ((result.stderr ?? '').includes('must have Python installed')) {
    return {
      name: 'gcloud auth',
      status: 'blocked',
      summary: 'Google Cloud CLI is installed but cannot start because it has no usable Python runtime.',
      remediation: 'Install Python 3 and ensure gcloud can see it, or set CLOUDSDK_PYTHON to a working python.exe before running setup.'
    } as const;
  }

  return {
    name: 'gcloud auth',
    status: 'blocked',
    summary: 'Google Cloud CLI is not authenticated on this machine.',
    remediation: 'Run gcloud auth login before asking setup to provision Google resources.'
  } as const;
}

export type ProvisionGoogleServiceAccountOptions = {
  profile: string;
  projectId: string;
  serviceAccountName: string;
};

export type ProvisionGoogleServiceAccountResult = {
  googleClientEmail: string;
  googlePrivateKey: string;
  projectId: string;
  serviceAccountEmail: string;
  createdProject: boolean;
  createdServiceAccount: boolean;
};

export async function provisionGoogleServiceAccount(
  options: ProvisionGoogleServiceAccountOptions,
  dependencies: GcloudDependencies = {}
): Promise<ProvisionGoogleServiceAccountResult> {
  const projectId = normalizeGoogleProjectId(options.projectId);
  const serviceAccountName = normalizeGoogleServiceAccountName(options.serviceAccountName);
  const serviceAccountEmail = createGoogleServiceAccountEmail(projectId, serviceAccountName);

  const projectListResult = await runGcloudCommand(
    ['projects', 'list', `--filter=projectId=${projectId}`, '--format=value(projectId)'],
    dependencies,
    {
      echoStdout: false,
      echoStderr: false
    }
  );
  if (projectListResult.code !== 0) {
    throw new ScriptError(`Failed to inspect Google Cloud projects for ${projectId}.`);
  }

  const createdProject = !parseLineList(projectListResult.stdout).includes(projectId);
  if (createdProject) {
    const createProjectResult = await runGcloudCommand(
      ['projects', 'create', projectId, `--name=${createGoogleServiceAccountDisplayName(options.profile)}`],
      dependencies
    );
    if (createProjectResult.code !== 0) {
      throw new ScriptError(`Failed to create Google Cloud project ${projectId}.`);
    }
  }

  const enableApisResult = await runGcloudCommand(
    ['services', 'enable', ...requiredGoogleApis, '--project', projectId],
    dependencies
  );
  if (enableApisResult.code !== 0) {
    throw new ScriptError(`Failed to enable required Google APIs for ${projectId}.`);
  }

  const serviceAccountListResult = await runGcloudCommand(
    ['iam', 'service-accounts', 'list', '--project', projectId, '--format=value(email)'],
    dependencies,
    {
      echoStdout: false,
      echoStderr: false
    }
  );
  if (serviceAccountListResult.code !== 0) {
    throw new ScriptError(`Failed to inspect Google service accounts for ${projectId}.`);
  }

  const createdServiceAccount = !parseLineList(serviceAccountListResult.stdout).includes(serviceAccountEmail);
  if (createdServiceAccount) {
    const createServiceAccountResult = await runGcloudCommand(
      [
        'iam',
        'service-accounts',
        'create',
        serviceAccountName,
        '--project',
        projectId,
        `--description=Dedicated service account for Sheetflare ${normalizeProfile(options.profile)}`,
        `--display-name=${createGoogleServiceAccountDisplayName(options.profile)}`
      ],
      dependencies
    );
    if (createServiceAccountResult.code !== 0) {
      throw new ScriptError(`Failed to create Google service account ${serviceAccountName} in ${projectId}.`);
    }

    await waitForServiceAccountVisibility(projectId, serviceAccountEmail, dependencies);
  }

  const tempDirFactory = dependencies.tempDirFactory ?? (() => mkdtemp(join(tmpdir(), 'sheetflare-google-')));
  const readTextFile = dependencies.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const removePath = dependencies.removePath ?? ((path: string) => rm(path, { force: true, recursive: true }));

  const tempDir = await tempDirFactory();
  const keyPath = join(tempDir, `${serviceAccountName}-key.json`);
  try {
    const createKeyResult = await runGcloudCommand(
      [
        'iam',
        'service-accounts',
        'keys',
        'create',
        keyPath,
        `--iam-account=${serviceAccountEmail}`,
        '--project',
        projectId
      ],
      dependencies
    );
    if (createKeyResult.code !== 0) {
      throw new ScriptError(`Failed to create a key for Google service account ${serviceAccountEmail}.`);
    }

    const keyJson = validateServiceAccountKeyJson(keyPath, await readTextFile(keyPath));
    return {
      googleClientEmail: keyJson.client_email.trim(),
      googlePrivateKey: keyJson.private_key,
      projectId,
      serviceAccountEmail,
      createdProject,
      createdServiceAccount
    };
  } finally {
    await removePath(tempDir);
  }
}
