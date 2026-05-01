import type { SetupConfig } from './setup-config';
import type { SetupPrereqResult } from './setup-prereqs';
import type { ResolvedSetupRuntimeState } from './setup-runtime';
import { listDriveWatches } from './setup-drive-watches';
import { getAdminPagesProjectName, getAdminPagesSiteUrl, listPagesProjects } from './setup-deploy';
import { isPlaceholderGoogleClientEmail } from './setup-google';
import { requestJson, ScriptError } from './runtime';
import { verifyAdminPagesDeployment } from './setup-verify';

type ReadyResponse = {
  ok: boolean;
  checks: {
    defaultGoogleCredential: 'configured' | 'missing';
    googleDriveWebhookSecret: 'configured' | 'missing';
    bootstrapAdmin: 'configured' | 'missing';
  };
  notes: string[];
};

type SetupDoctorDependencies = {
  fetchReady?: (apiUrl: string) => Promise<ReadyResponse>;
  listPagesProjects?: typeof listPagesProjects;
  verifyAdminPagesDeployment?: typeof verifyAdminPagesDeployment;
  listDriveWatches?: typeof listDriveWatches;
};

function createResult(
  name: string,
  status: SetupPrereqResult['status'],
  summary: string,
  remediation: string | null
): SetupPrereqResult {
  return {
    name,
    status,
    summary,
    remediation
  };
}

async function fetchReadyStatus(apiUrl: string) {
  const { data } = await requestJson<ReadyResponse>({
    baseUrl: apiUrl,
    path: '/ready',
    method: 'GET',
    expectedStatus: 200
  });

  if (!data) {
    throw new ScriptError('API /ready returned an empty response.');
  }

  return data;
}

function getConfiguredSpreadsheetIds(config: SetupConfig) {
  const spreadsheetIds = new Set<string>([config.privateProject.spreadsheetId]);
  if (config.publicReadProject) {
    spreadsheetIds.add(config.publicReadProject.spreadsheetId);
  }

  return [...spreadsheetIds];
}

function getExpiredWatchSpreadsheetIds(watches: Awaited<ReturnType<typeof listDriveWatches>>) {
  const now = Date.now();
  return watches
    .filter((watch) => watch.expirationAt !== null)
    .filter((watch) => {
      const expirationAtMs = Date.parse(watch.expirationAt!);
      return !Number.isNaN(expirationAtMs) && expirationAtMs <= now;
    })
    .map((watch) => watch.spreadsheetId);
}

function getErroredWatchSpreadsheetIds(watches: Awaited<ReturnType<typeof listDriveWatches>>) {
  return watches
    .filter((watch) => watch.lastWatchError !== null)
    .map((watch) => watch.spreadsheetId);
}

export async function runSetupDoctor(options: {
  config: SetupConfig;
  runtimeState: ResolvedSetupRuntimeState;
  prereqResults: SetupPrereqResult[];
}, dependencies: SetupDoctorDependencies = {}) {
  const results: SetupPrereqResult[] = [];
  const prereqByName = new Map(options.prereqResults.map((result) => [result.name, result] as const));
  const wranglerResult = prereqByName.get('Wrangler auth') ?? null;
  const fetchReady = dependencies.fetchReady ?? fetchReadyStatus;
  const listPagesProjectsImpl = dependencies.listPagesProjects ?? listPagesProjects;
  const verifyAdminPagesDeploymentImpl = dependencies.verifyAdminPagesDeployment ?? verifyAdminPagesDeployment;
  const listDriveWatchesImpl = dependencies.listDriveWatches ?? listDriveWatches;

  const googleClientEmail = options.runtimeState.googleClientEmail;
  if (!googleClientEmail) {
    results.push(createResult(
      'Google credential',
      'blocked',
      'No default Google service-account email is available from local setup state or the environment.',
      'Run npm run setup -- --apply-secrets --provision-google, or set a real GOOGLE_CLIENT_EMAIL before deploy/bootstrap.'
    ));
  } else if (isPlaceholderGoogleClientEmail(googleClientEmail)) {
    results.push(createResult(
      'Google credential',
      'blocked',
      `GOOGLE_CLIENT_EMAIL is still set to the checked-in placeholder ${googleClientEmail}.`,
      'Provision a real Google service account, then rerun npm run setup -- --apply-secrets or set GOOGLE_CLIENT_EMAIL to the real client email.'
    ));
  } else {
    results.push(createResult(
      'Google credential',
      'ready',
      `Default Google service-account email is ${googleClientEmail}.`,
      null
    ));
  }

  if (options.runtimeState.apiUrl) {
    try {
      const ready = await fetchReady(options.runtimeState.apiUrl);
      if (ready.checks.defaultGoogleCredential !== 'configured') {
        results.push(createResult(
          'API readiness',
          'blocked',
          'API /ready reports the default Google credential as missing.',
          'Apply a real GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY, then redeploy the Worker.'
        ));
      } else if (ready.checks.googleDriveWebhookSecret !== 'configured') {
        results.push(createResult(
          'API readiness',
          'warning',
          'API /ready is healthy, but GOOGLE_DRIVE_WEBHOOK_SECRET is missing so automatic Drive-watch reindexing is unavailable.',
          'Apply GOOGLE_DRIVE_WEBHOOK_SECRET through setup or wrangler secret put, then redeploy if needed.'
        ));
      } else {
        results.push(createResult(
          'API readiness',
          'ready',
          'API /ready reports the Worker as healthy with Google credentials and Drive webhook secret configured.',
          null
        ));
      }
    } catch (error) {
      results.push(createResult(
        'API readiness',
        'blocked',
        `Failed to verify API /ready at ${options.runtimeState.apiUrl}.`,
        error instanceof Error ? error.message : String(error)
      ));
    }
  } else {
    results.push(createResult(
      'API readiness',
      'blocked',
      'No API base URL is available from local setup state or the environment.',
      'Run npm run setup -- --deploy, or set SHEETFLARE_BASE_URL before verification.'
    ));
  }

  if (options.config.deploy.admin) {
    if (wranglerResult?.status === 'ready') {
      try {
        const projects = await listPagesProjectsImpl();
        const projectName = getAdminPagesProjectName(options.config.profile);
        if (projects.some((project) => project.name === projectName)) {
          results.push(createResult(
            'Admin Pages project',
            'ready',
            `Cloudflare Pages project ${projectName} exists.`,
            null
          ));
        } else {
          results.push(createResult(
            'Admin Pages project',
            'blocked',
            `Cloudflare Pages project ${projectName} does not exist.`,
            'Run npm run setup -- --deploy to create it automatically, or create it manually with wrangler pages project create.'
          ));
        }
      } catch (error) {
        results.push(createResult(
          'Admin Pages project',
          'warning',
          'Cloudflare Pages project existence could not be verified.',
          error instanceof Error ? error.message : String(error)
        ));
      }
    } else {
      results.push(createResult(
        'Admin Pages project',
        'warning',
        'Cloudflare Pages project existence was not checked because Wrangler auth is unavailable.',
        'Run npx wrangler login, then rerun npm run setup -- --verify.'
      ));
    }

    const adminUrl = options.runtimeState.adminUrl ?? getAdminPagesSiteUrl(getAdminPagesProjectName(options.config.profile));
    if (!options.runtimeState.adminUiUsername || !options.runtimeState.adminUiPassword) {
      results.push(createResult(
        'Admin Pages verification',
        'warning',
        `Admin site verification was skipped because ADMIN_UI_USERNAME or ADMIN_UI_PASSWORD was not available for ${adminUrl}.`,
        'Run npm run setup -- --apply-secrets, or set ADMIN_UI_USERNAME and ADMIN_UI_PASSWORD before verification.'
      ));
    } else {
      try {
        await verifyAdminPagesDeploymentImpl({
          siteUrl: adminUrl,
          username: options.runtimeState.adminUiUsername,
          password: options.runtimeState.adminUiPassword
        });
        results.push(createResult(
          'Admin Pages verification',
          'ready',
          `Verified protected admin root and proxied /docs at ${adminUrl}.`,
          null
        ));
      } catch (error) {
        results.push(createResult(
          'Admin Pages verification',
          'blocked',
          `Failed to verify the protected admin site at ${adminUrl}.`,
          error instanceof Error ? error.message : String(error)
        ));
      }
    }
  }

  if (!options.runtimeState.apiUrl || !options.runtimeState.adminApiKey && !options.runtimeState.adminBearerToken) {
    results.push(createResult(
      'Drive watch status',
      'warning',
      'Drive watch verification was skipped because the API URL or an admin credential was unavailable.',
      'Provide SHEETFLARE_BASE_URL and SHEETFLARE_ADMIN_CREDENTIAL, or rerun setup after bootstrap.'
    ));
  } else {
    try {
      const watches = await listDriveWatchesImpl({
        baseUrl: options.runtimeState.apiUrl,
        adminCredential: options.runtimeState.adminApiKey ?? options.runtimeState.adminBearerToken!,
        retries: 2,
        retryDelayMs: 1000
      });
      const configuredSpreadsheetIds = getConfiguredSpreadsheetIds(options.config);
      const watchIds = new Set(watches.map((watch) => watch.spreadsheetId));
      const missingSpreadsheetIds = configuredSpreadsheetIds.filter((spreadsheetId) => !watchIds.has(spreadsheetId));
      const expiredSpreadsheetIds = getExpiredWatchSpreadsheetIds(watches);
      const erroredSpreadsheetIds = getErroredWatchSpreadsheetIds(watches);

      if (missingSpreadsheetIds.length > 0) {
        results.push(createResult(
          'Drive watch status',
          'warning',
          `Configured spreadsheets are missing Drive watches: ${missingSpreadsheetIds.join(', ')}.`,
          'Run npm run ops:watch:drive, then re-check with npm run ops:watch:drive:status.'
        ));
      } else if (expiredSpreadsheetIds.length > 0 || erroredSpreadsheetIds.length > 0) {
        const issues: string[] = [];
        if (expiredSpreadsheetIds.length > 0) {
          issues.push(`expired: ${expiredSpreadsheetIds.join(', ')}`);
        }
        if (erroredSpreadsheetIds.length > 0) {
          issues.push(`errored: ${erroredSpreadsheetIds.join(', ')}`);
        }
        results.push(createResult(
          'Drive watch status',
          'warning',
          `Drive watches exist for configured spreadsheets, but renewal health is degraded (${issues.join('; ')}).`,
          'Inspect npm run ops:watch:drive:status and the operator runbook, then renew or repair the affected watches.'
        ));
      } else {
        results.push(createResult(
          'Drive watch status',
          'ready',
          `Confirmed Drive watches for all configured spreadsheets (${configuredSpreadsheetIds.length}).`,
          null
        ));
      }
    } catch (error) {
      results.push(createResult(
        'Drive watch status',
        'blocked',
        'Failed to read Drive watch status through the admin API.',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  return results;
}
