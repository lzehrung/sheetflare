import { describe, expect, it, vi } from 'vitest';
import {
  checkGcloudAuthPrereq,
  createGoogleServiceAccountEmail,
  getNamedGoogleCredentialsStatus,
  getActiveGcloudProjectId,
  getDefaultGoogleProjectId,
  getDefaultGoogleServiceAccountName,
  isPlaceholderGoogleClientEmail,
  normalizeGoogleProjectId,
  normalizeGoogleServiceAccountName,
  provisionGoogleServiceAccount
} from './setup-google';

const noPythonLookup = async () => null;

describe('google setup defaults', () => {
  it('derives production and staging defaults from the setup profile', () => {
    expect(getDefaultGoogleProjectId('production')).toBe('sheetflare-prod');
    expect(getDefaultGoogleProjectId('staging')).toBe('sheetflare-staging');
    expect(getDefaultGoogleProjectId('demo')).toBe('sheetflare-demo');
    expect(getDefaultGoogleServiceAccountName('production')).toBe('sheetflare-prod');
  });

  it('builds the canonical service-account email', () => {
    expect(createGoogleServiceAccountEmail('sheetflare-prod', 'sheetflare-prod'))
      .toBe('sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com');
  });

  it('detects the checked-in placeholder client email', () => {
    expect(isPlaceholderGoogleClientEmail('service-account@your-gcp-project.iam.gserviceaccount.com')).toBe(true);
    expect(isPlaceholderGoogleClientEmail('sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com')).toBe(false);
  });

  it('classifies named Google credential JSON accurately', () => {
    expect(getNamedGoogleCredentialsStatus(null)).toBe('missing');
    expect(getNamedGoogleCredentialsStatus('not-json')).toBe('invalid');
    expect(getNamedGoogleCredentialsStatus(JSON.stringify({
      prod: {
        client_email: 'service@example.com',
        private_key: 'secret'
      }
    }))).toBe('configured');
    expect(getNamedGoogleCredentialsStatus(JSON.stringify({
      prod: {
        clientEmail: 'service@example.com',
        privateKey: 'secret'
      }
    }))).toBe('configured');
  });

  it('validates project and service-account names clearly', () => {
    expect(normalizeGoogleProjectId('sheetflare-prod')).toBe('sheetflare-prod');
    expect(normalizeGoogleServiceAccountName('sheetflare-prod')).toBe('sheetflare-prod');
    expect(() => normalizeGoogleProjectId('Prod')).toThrow('Google Cloud project ID');
    expect(() => normalizeGoogleServiceAccountName('prod')).toThrow('Google service-account name');
  });
});

describe('getActiveGcloudProjectId', () => {
  it('returns the active gcloud project when it is valid', async () => {
    await expect(getActiveGcloudProjectId({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: 'operator-project\n',
        stderr: ''
      }))
    })).resolves.toBe('operator-project');
  });

  it('ignores unset or invalid active gcloud projects', async () => {
    await expect(getActiveGcloudProjectId({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: '(unset)\n',
        stderr: ''
      }))
    })).resolves.toBeNull();

    await expect(getActiveGcloudProjectId({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: 'Not Valid\n',
        stderr: ''
      }))
    })).resolves.toBeNull();
  });
});

describe('checkGcloudAuthPrereq', () => {
  it('reports ready when gcloud has an active account', async () => {
    await expect(checkGcloudAuthPrereq({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 0,
        stdout: 'user@example.com\n',
        stderr: ''
      }))
    })).resolves.toEqual({
      name: 'gcloud auth',
      status: 'ready',
      summary: 'Google Cloud authentication is available for setup provisioning.',
      remediation: null
    });
  });

  it('reports a Python-specific remediation when gcloud cannot start', async () => {
    await expect(checkGcloudAuthPrereq({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 1,
        stdout: '',
        stderr: 'To use the Google Cloud CLI, you must have Python installed and on your PATH.'
      }))
    })).resolves.toEqual({
      name: 'gcloud auth',
      status: 'blocked',
      summary: 'Google Cloud CLI is installed but cannot start because it has no usable Python runtime.',
      remediation: 'Install Python 3 and ensure gcloud can see it, or set CLOUDSDK_PYTHON to a working python.exe before running setup.'
    });
  });

  it('tells operators to install gcloud when the command is missing', async () => {
    await expect(checkGcloudAuthPrereq({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 1,
        stdout: '',
        stderr: 'spawn gcloud ENOENT\n'
      }))
    })).resolves.toEqual({
      name: 'gcloud auth',
      status: 'blocked',
      summary: 'Google Cloud CLI is not installed or is not on PATH.',
      remediation: 'Install the Google Cloud CLI, then run gcloud auth login and rerun npm run setup.'
    });
  });

  it('tells operators how to authenticate gcloud for setup provisioning', async () => {
    await expect(checkGcloudAuthPrereq({
      pythonExecutableResolver: noPythonLookup,
      commandRunner: vi.fn(async () => ({
        code: 1,
        stdout: '',
        stderr: 'No credentialed accounts.'
      }))
    })).resolves.toMatchObject({
      name: 'gcloud auth',
      status: 'blocked',
      remediation: 'Run gcloud auth login, then rerun npm run setup.'
    });
  });
});

describe('provisionGoogleServiceAccount', () => {
  it('creates the project and service account when missing, then returns generated credentials', async () => {
    const commands: string[] = [];
    const keyJson = JSON.stringify({
      client_email: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n'
    });
    let listCallCount = 0;

    const result = await provisionGoogleServiceAccount(
      {
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      {
        commandRunner: vi.fn(async (command, args) => {
          commands.push([command, ...args].join(' '));
          const joined = args.join(' ');
          if (joined.startsWith('projects list')) {
            return { code: 0, stdout: '', stderr: '' };
          }
          if (joined.startsWith('projects create')) {
            return { code: 0, stdout: 'created', stderr: '' };
          }
          if (joined.startsWith('services enable')) {
            return { code: 0, stdout: 'enabled', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts list')) {
            listCallCount += 1;
            return {
              code: 0,
              stdout: listCallCount < 2 ? '' : 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com\n',
              stderr: ''
            };
          }
          if (joined.startsWith('iam service-accounts create')) {
            return { code: 0, stdout: 'created', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts keys create')) {
            return { code: 0, stdout: 'created key', stderr: '' };
          }
          throw new Error(`Unexpected gcloud command: ${joined}`);
        }),
        sleep: vi.fn(async () => undefined),
        tempDirFactory: vi.fn(async () => 'C:/tmp/sheetflare-google-test'),
        readTextFile: vi.fn(async () => keyJson),
        removePath: vi.fn(async () => undefined),
        pythonExecutableResolver: vi.fn(async () => 'C:/Python313/python.exe')
      }
    );

    expect(result).toEqual({
      googleClientEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
      googlePrivateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
      projectId: 'sheetflare-prod',
      serviceAccountEmail: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
      createdProject: true,
      createdServiceAccount: true
    });
    expect(commands.some((command) => command.includes('projects create sheetflare-prod'))).toBe(true);
    expect(commands.some((command) => command.includes('iam service-accounts create sheetflare-prod'))).toBe(true);
    expect(commands.some((command) => command.includes('iam service-accounts keys create'))).toBe(true);
  });

  it('reuses an existing project and service account without recreating them', async () => {
    const commands: string[] = [];
    const result = await provisionGoogleServiceAccount(
      {
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      {
        commandRunner: vi.fn(async (command, args) => {
          commands.push([command, ...args].join(' '));
          const joined = args.join(' ');
          if (joined.startsWith('projects list')) {
            return { code: 0, stdout: 'sheetflare-prod\n', stderr: '' };
          }
          if (joined.startsWith('services enable')) {
            return { code: 0, stdout: 'enabled', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts list')) {
            return { code: 0, stdout: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com\n', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts keys create')) {
            return { code: 0, stdout: 'created key', stderr: '' };
          }
          throw new Error(`Unexpected gcloud command: ${joined}`);
        }),
        tempDirFactory: vi.fn(async () => 'C:/tmp/sheetflare-google-test'),
        readTextFile: vi.fn(async () => JSON.stringify({
          client_email: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
          private_key: 'secret'
        })),
        removePath: vi.fn(async () => undefined),
        pythonExecutableResolver: vi.fn(async () => 'C:/Python313/python.exe')
      }
    );

    expect(result.createdProject).toBe(false);
    expect(result.createdServiceAccount).toBe(false);
    expect(commands.some((command) => command.includes('projects create sheetflare-prod'))).toBe(false);
    expect(commands.some((command) => command.includes('iam service-accounts create sheetflare-prod'))).toBe(false);
  });

  it('keeps gcloud provisioning command output quiet by default', async () => {
    const commandOptions: Array<{ echoStdout?: boolean; echoStderr?: boolean } | undefined> = [];

    await provisionGoogleServiceAccount(
      {
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      {
        commandRunner: vi.fn(async (_command, args, options) => {
          commandOptions.push(options);
          const joined = args.join(' ');
          if (joined.startsWith('projects list')) {
            return { code: 0, stdout: 'sheetflare-prod\n', stderr: '' };
          }
          if (joined.startsWith('services enable')) {
            return { code: 0, stdout: 'enabled', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts list')) {
            return { code: 0, stdout: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com\n', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts keys create')) {
            return { code: 0, stdout: 'created key', stderr: '' };
          }
          throw new Error(`Unexpected gcloud command: ${joined}`);
        }),
        tempDirFactory: vi.fn(async () => 'C:/tmp/sheetflare-google-test'),
        readTextFile: vi.fn(async () => JSON.stringify({
          client_email: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
          private_key: 'secret'
        })),
        removePath: vi.fn(async () => undefined),
        pythonExecutableResolver: vi.fn(async () => 'C:/Python313/python.exe')
      }
    );

    expect(commandOptions.every((options) => options?.echoStdout === false && options.echoStderr === false)).toBe(true);
  });

  it('shows gcloud provisioning command output in debug mode', async () => {
    const commandOptions: Array<{ echoStdout?: boolean; echoStderr?: boolean } | undefined> = [];

    await provisionGoogleServiceAccount(
      {
        profile: 'production',
        projectId: 'sheetflare-prod',
        serviceAccountName: 'sheetflare-prod'
      },
      {
        debug: true,
        commandRunner: vi.fn(async (_command, args, options) => {
          commandOptions.push(options);
          const joined = args.join(' ');
          if (joined.startsWith('projects list')) {
            return { code: 0, stdout: 'sheetflare-prod\n', stderr: '' };
          }
          if (joined.startsWith('services enable')) {
            return { code: 0, stdout: 'enabled', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts list')) {
            return { code: 0, stdout: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com\n', stderr: '' };
          }
          if (joined.startsWith('iam service-accounts keys create')) {
            return { code: 0, stdout: 'created key', stderr: '' };
          }
          throw new Error(`Unexpected gcloud command: ${joined}`);
        }),
        tempDirFactory: vi.fn(async () => 'C:/tmp/sheetflare-google-test'),
        readTextFile: vi.fn(async () => JSON.stringify({
          client_email: 'sheetflare-prod@sheetflare-prod.iam.gserviceaccount.com',
          private_key: 'secret'
        })),
        removePath: vi.fn(async () => undefined),
        pythonExecutableResolver: vi.fn(async () => 'C:/Python313/python.exe')
      }
    );

    expect(commandOptions.every((options) => options?.echoStdout === true && options.echoStderr === true)).toBe(true);
  });
});
