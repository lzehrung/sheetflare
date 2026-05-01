import type { SetupConfig } from './setup-config';
import type { SetupPrereqResult } from './setup-prereqs';
import type { ResolvedSetupRuntimeState } from './setup-runtime';
import { listDriveWatchRetryAdvice, listDriveWatches } from './setup-drive-watches';
import { getAdminPagesProjectName, getAdminPagesSiteUrl, listPagesProjects } from './setup-deploy';
import { isPlaceholderGoogleClientEmail } from './setup-google';
import { requestJson, ScriptError } from './runtime';
import { verifyAdminPagesDeployment } from './setup-verify';

type ReadyResponse = {
  ok: boolean;
  checks: {
    defaultGoogleCredential: 'configured' | 'missing';
    namedGoogleCredentials: 'configured' | 'missing' | 'invalid';
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
  listDriveWatchRetryAdvice?: typeof listDriveWatchRetryAdvice;
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

export function getSetupDoctorFailureMessage(results: SetupPrereqResult[]) {
  const blockedResults = results.filter((result) => result.status === 'blocked');
  const warningResults = results.filter((result) => result.status === 'warning');
  if (blockedResults.length === 0 && warningResults.length === 0) {
    return null;
  }

  const issues = [
    blockedResults.length > 0
      ? `${blockedResults.length} blocking issue${blockedResults.length === 1 ? '' : 's'}`
      : null,
    warningResults.length > 0
      ? `${warningResults.length} warning${warningResults.length === 1 ? '' : 's'}`
      : null
  ].filter(Boolean).join(' and ');

  return `Setup verification found ${issues}.`;
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

function getRetryAdviceBySpreadsheetId(
  retryAdvice: Awaited<ReturnType<typeof listDriveWatchRetryAdvice>>
) {
  return new Map(retryAdvice.map((entry) => [entry.spreadsheetId, entry] as const));
}

function getConfiguredGoogleCredentialRefs(config: SetupConfig) {
  const refs = new Set<string>([config.privateProject.googleCredentialRef ?? 'default']);
  if (config.publicReadProject) {
    refs.add(config.publicReadProject.googleCredentialRef ?? 'default');
  }

  return refs;
}

function describeReadyCredentialSummary(ready: ReadyResponse['checks']) {
  if (ready.defaultGoogleCredential === 'configured' && ready.namedGoogleCredentials === 'configured') {
    return 'default and named Google credentials';
  }

  if (ready.defaultGoogleCredential === 'configured') {
    return 'the default Google credential';
  }

  return 'named Google credentials';
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
  const listDriveWatchRetryAdviceImpl = dependencies.listDriveWatchRetryAdvice ?? listDriveWatchRetryAdvice;

  const googleClientEmail = options.runtimeState.googleClientEmail;
  const namedGoogleCredentials = options.runtimeState.namedGoogleCredentials;
  const configuredRefs = getConfiguredGoogleCredentialRefs(options.config);
  const usesDefaultGoogleCredential = configuredRefs.has('default');
  const usesNamedGoogleCredential = [...configuredRefs].some((ref) => ref !== 'default');
  const hasDefaultGoogleCredential = Boolean(googleClientEmail) && !isPlaceholderGoogleClientEmail(googleClientEmail);

  if (usesDefaultGoogleCredential && !googleClientEmail) {
    results.push(createResult(
      'Google credential',
      'blocked',
      'A configured project uses the default Google credential, but no default Google service-account email is available from local setup state or the environment.',
      'Run npm run setup -- --apply-secrets --provision-google, or set a real GOOGLE_CLIENT_EMAIL before deploy/bootstrap.'
    ));
  } else if (usesDefaultGoogleCredential && googleClientEmail && isPlaceholderGoogleClientEmail(googleClientEmail)) {
    results.push(createResult(
      'Google credential',
      'blocked',
      `A configured project uses the default Google credential, but GOOGLE_CLIENT_EMAIL is still set to the checked-in placeholder ${googleClientEmail}.`,
      'Provision a real Google service account, then rerun npm run setup -- --apply-secrets or set GOOGLE_CLIENT_EMAIL to the real client email.'
    ));
  } else if (usesNamedGoogleCredential && namedGoogleCredentials === 'missing') {
    results.push(createResult(
      'Google credential',
      'blocked',
      'A configured project uses a named Google credential ref, but GOOGLE_CREDENTIALS_JSON is not set.',
      'Apply GOOGLE_CREDENTIALS_JSON as a Worker secret, or change the project config to use the default credential.'
    ));
  } else if (usesNamedGoogleCredential && namedGoogleCredentials === 'invalid') {
    results.push(createResult(
      'Google credential',
      'blocked',
      'A configured project uses a named Google credential ref, but GOOGLE_CREDENTIALS_JSON is missing required client_email/private_key fields or is not valid JSON.',
      'Fix GOOGLE_CREDENTIALS_JSON, then rerun npm run setup -- --verify.'
    ));
  } else if (hasDefaultGoogleCredential && namedGoogleCredentials === 'configured') {
    results.push(createResult(
      'Google credential',
      'ready',
      `Default Google service-account email is ${googleClientEmail}, and named Google credentials are configured for non-default refs.`,
      null
    ));
  } else if (hasDefaultGoogleCredential) {
    results.push(createResult(
      'Google credential',
      'ready',
      `Default Google service-account email is ${googleClientEmail}.`,
      null
    ));
  } else if (namedGoogleCredentials === 'configured') {
    results.push(createResult(
      'Google credential',
      'ready',
      'Named Google credentials are configured through GOOGLE_CREDENTIALS_JSON for the refs declared in setup config.',
      null
    ));
  } else {
    results.push(createResult(
      'Google credential',
      'blocked',
      'No Google credential source is configured for the refs declared in setup config.',
      'Apply a default GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY pair or provide valid GOOGLE_CREDENTIALS_JSON for the configured refs.'
    ));
  }

  if (options.runtimeState.apiUrl) {
    try {
      const ready = await fetchReady(options.runtimeState.apiUrl);
      const hasAnyReadyGoogleCredential =
        ready.checks.defaultGoogleCredential === 'configured' ||
        ready.checks.namedGoogleCredentials === 'configured';

      if (!hasAnyReadyGoogleCredential) {
        results.push(createResult(
          'API readiness',
          'blocked',
          'API /ready reports that neither the default Google credential nor named Google credentials are configured.',
          'Apply a real GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY pair or a valid GOOGLE_CREDENTIALS_JSON secret, then redeploy the Worker.'
        ));
      } else if (usesNamedGoogleCredential && ready.checks.namedGoogleCredentials === 'invalid') {
        results.push(createResult(
          'API readiness',
          'blocked',
          'API /ready reports GOOGLE_CREDENTIALS_JSON as invalid.',
          'Fix GOOGLE_CREDENTIALS_JSON so every named entry has non-empty client_email and private_key fields, then redeploy the Worker.'
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
          `API /ready reports the Worker as healthy with ${describeReadyCredentialSummary(ready.checks)} and the Drive webhook secret configured.`,
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
          `Verified the protected admin root plus proxied /ready, /docs, and /v1/admin/projects at ${adminUrl}.`,
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
      const retryAdvice = await listDriveWatchRetryAdviceImpl({
        baseUrl: options.runtimeState.apiUrl,
        adminCredential: options.runtimeState.adminApiKey ?? options.runtimeState.adminBearerToken!
      });
      const configuredSpreadsheetIds = getConfiguredSpreadsheetIds(options.config);
      const watchIds = new Set(watches.map((watch) => watch.spreadsheetId));
      const retryAdviceBySpreadsheetId = getRetryAdviceBySpreadsheetId(retryAdvice);
      const missingSpreadsheetIds = configuredSpreadsheetIds.filter((spreadsheetId) => !watchIds.has(spreadsheetId));
      const expiredSpreadsheetIds = getExpiredWatchSpreadsheetIds(watches);
      const erroredSpreadsheetIds = getErroredWatchSpreadsheetIds(watches);
      const cooldownSpreadsheetIds = missingSpreadsheetIds.filter(
        (spreadsheetId) => retryAdviceBySpreadsheetId.get(spreadsheetId)?.status === 'cooldown-recommended'
      );
      const readyToRetrySpreadsheetIds = missingSpreadsheetIds.filter((spreadsheetId) => {
        const advice = retryAdviceBySpreadsheetId.get(spreadsheetId);
        return advice?.status !== 'cooldown-recommended';
      });

      if (readyToRetrySpreadsheetIds.length > 0) {
        results.push(createResult(
          'Drive watch status',
          'warning',
          `Configured spreadsheets are missing Drive watches and are ready to retry: ${readyToRetrySpreadsheetIds.join(', ')}.`,
          'Run npm run ops:watch:drive, then re-check with npm run ops:watch:drive:status.'
        ));
      } else if (cooldownSpreadsheetIds.length > 0) {
        const adviceSummary = cooldownSpreadsheetIds.map((spreadsheetId) => {
          const advice = retryAdviceBySpreadsheetId.get(spreadsheetId);
          return advice?.safeRetryAt ? `${spreadsheetId} (retry after ${advice.safeRetryAt})` : spreadsheetId;
        });
        results.push(createResult(
          'Drive watch status',
          'warning',
          `Configured spreadsheets are intentionally missing Drive watches during the cooldown window: ${adviceSummary.join(', ')}.`,
          'Wait until after the reported safe retry time, then run npm run ops:watch:drive.'
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
