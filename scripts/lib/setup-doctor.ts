import { z } from 'zod';
import { getSetupConfigGoogleCredentialRefs, type SetupConfig } from './setup-config';
import type { SetupPrereqResult } from './setup-prereqs';
import { resolvePreferredAdminCredential, type ResolvedSetupRuntimeState } from './setup-runtime';
import { listDriveWatchRetryAdvice, listDriveWatches } from './setup-drive-watches';
import { isPlaceholderGoogleClientEmail } from './setup-google';
import { requestJson, ScriptError } from './runtime';

const readyChecksSchema = z.object({
  defaultGoogleCredential: z.enum(['configured', 'missing']),
  namedGoogleCredentials: z.enum(['configured', 'missing', 'invalid']),
  googleDriveWebhookSecret: z.enum(['configured', 'missing']),
  bootstrapAdmin: z.enum(['configured', 'missing']),
  adminUi: z.enum(['enabled', 'disabled', 'invalid', 'assets-missing']).optional()
});

// Anonymous callers get only { ok, service }; checks and notes need the bootstrap token or a global admin:projects key.
const readyResponseSchema = z.object({
  ok: z.boolean(),
  service: z.string().optional(),
  checks: readyChecksSchema.optional(),
  notes: z.array(z.string()).optional()
});

type ReadyResponse = z.infer<typeof readyResponseSchema>;
type ReadyChecks = z.infer<typeof readyChecksSchema>;

const READY_DETAILS_UNAVAILABLE_SUMMARY = 'API /ready did not include readiness details, so the Google credential, webhook secret, and admin UI state could not be verified.';
const READY_DETAILS_GUIDANCE = 'Set SHEETFLARE_ADMIN_CREDENTIAL to a global API key with admin:projects scope or to the bootstrap admin token, then rerun npm run setup -- --verify.';

class ReadyScopeError extends ScriptError {}

type SetupDoctorDependencies = {
  fetchReady?: (apiUrl: string, credential: string | null) => Promise<ReadyResponse>;
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

async function fetchReadyStatus(apiUrl: string, credential: string | null): Promise<ReadyResponse> {
  const { response, data } = await requestJson<unknown>({
    baseUrl: apiUrl,
    path: '/ready',
    method: 'GET',
    bearer: credential
  });

  if (response.status === 403) {
    throw new ReadyScopeError('API /ready returned 403 for the admin credential.');
  }

  if (![200, 503].includes(response.status)) {
    const requestId = response.headers.get('x-request-id');
    throw new ScriptError(
      [
        `Expected GET /ready to return 200 or 503, received ${response.status}.`,
        requestId ? `requestId=${requestId}` : null
      ].filter(Boolean).join(' ')
    );
  }

  if (!data) {
    throw new ScriptError('API /ready returned an empty response.');
  }

  const parsed = readyResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new ScriptError('API /ready returned a response that does not match the expected shape.');
  }

  return parsed.data;
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

function describeReadyCredentialSummary(ready: ReadyChecks) {
  if (ready.defaultGoogleCredential === 'configured' && ready.namedGoogleCredentials === 'configured') {
    return 'default and named Google credentials';
  }

  if (ready.defaultGoogleCredential === 'configured') {
    return 'the default Google credential';
  }

  return 'named Google credentials';
}

function describeAdminUiResult(
  deployed: ReadyChecks['adminUi'],
  configured: SetupConfig['adminUi'],
  apiUrl: string
): SetupPrereqResult {
  const redeployHint = 'Run npm run setup -- --deploy to redeploy the Worker with the configured admin UI setting.';
  if (deployed === undefined) {
    return createResult('Admin UI', 'warning', 'The deployed Worker predates the hosted admin UI.', redeployHint);
  }
  if (deployed === 'invalid' || deployed === 'assets-missing') {
    return createResult('Admin UI', 'blocked', `API /ready reports the hosted admin UI as ${deployed}.`, redeployHint);
  }
  if (deployed !== configured) {
    return createResult('Admin UI', 'warning', `The deployed Worker has the hosted admin UI ${deployed}, but setup config sets adminUi to ${configured}.`, redeployHint);
  }
  if (deployed === 'enabled') {
    return createResult('Admin UI', 'ready', `Hosted admin UI is enabled at ${apiUrl}/admin/.`, null);
  }
  return createResult('Admin UI', 'ready', 'Hosted admin UI is disabled by setup config.', null);
}

export async function runSetupDoctor(options: {
  config: SetupConfig;
  runtimeState: ResolvedSetupRuntimeState;
}, dependencies: SetupDoctorDependencies = {}) {
  const results: SetupPrereqResult[] = [];
  const fetchReady = dependencies.fetchReady ?? fetchReadyStatus;
  const listDriveWatchesImpl = dependencies.listDriveWatches ?? listDriveWatches;
  const listDriveWatchRetryAdviceImpl = dependencies.listDriveWatchRetryAdvice ?? listDriveWatchRetryAdvice;

  const googleClientEmail = options.runtimeState.googleClientEmail;
  const namedGoogleCredentials = options.runtimeState.namedGoogleCredentials;
  const configuredRefs = getSetupConfigGoogleCredentialRefs(options.config);
  const usesDefaultGoogleCredential = configuredRefs.has('default');
  const usesNamedGoogleCredential = [...configuredRefs].some((ref) => ref !== 'default');
  const hasDefaultGoogleCredential = Boolean(googleClientEmail) && !isPlaceholderGoogleClientEmail(googleClientEmail);

  if (usesDefaultGoogleCredential && !googleClientEmail && !options.runtimeState.apiUrl) {
    results.push(createResult(
      'Google credential',
      'blocked',
      'A configured project uses the default Google credential, but no default Google service-account email is available from local setup state or the environment.',
      'Run npm run setup -- --apply-secrets --provision-google, or set a real GOOGLE_CLIENT_EMAIL before deploy/bootstrap.'
    ));
  } else if (usesDefaultGoogleCredential && !googleClientEmail) {
    results.push(createResult(
      'Google credential',
      'ready',
      'A configured project uses the default Google credential; deployed Worker readiness will verify that credential because the local service-account email is not available.',
      null
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
      'A configured project uses a named Google credential ref, but GOOGLE_CREDENTIALS_JSON is missing required client_email/private_key or clientEmail/privateKey fields or is not valid JSON.',
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
      const ready = await fetchReady(options.runtimeState.apiUrl, resolvePreferredAdminCredential(options.runtimeState));
      if (!ready.checks) {
        results.push(createResult(
          'API readiness',
          'warning',
          READY_DETAILS_UNAVAILABLE_SUMMARY,
          READY_DETAILS_GUIDANCE
        ));
      } else {
        const checks = ready.checks;
        const hasAnyReadyGoogleCredential =
          checks.defaultGoogleCredential === 'configured' ||
          checks.namedGoogleCredentials === 'configured';

        if (!hasAnyReadyGoogleCredential) {
          results.push(createResult(
            'API readiness',
            'blocked',
            'API /ready reports that neither the default Google credential nor named Google credentials are configured.',
            'Apply a real GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY pair or a valid GOOGLE_CREDENTIALS_JSON secret, then redeploy the Worker.'
          ));
        } else if (usesNamedGoogleCredential && checks.namedGoogleCredentials === 'invalid') {
          results.push(createResult(
            'API readiness',
            'blocked',
            'API /ready reports GOOGLE_CREDENTIALS_JSON as invalid.',
            'Fix GOOGLE_CREDENTIALS_JSON so every named entry has non-empty client_email/private_key or clientEmail/privateKey fields, then redeploy the Worker.'
          ));
        } else if (checks.googleDriveWebhookSecret !== 'configured') {
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
            `API /ready reports the Worker as healthy with ${describeReadyCredentialSummary(checks)} and the Drive webhook secret configured.`,
            null
          ));
        }

        results.push(describeAdminUiResult(checks.adminUi, options.config.adminUi, options.runtimeState.apiUrl));
      }
    } catch (error) {
      if (error instanceof ReadyScopeError) {
        results.push(createResult(
          'API readiness',
          'warning',
          'API /ready returned 403 for the admin credential, so it lacks global scope and readiness details are unavailable.',
          READY_DETAILS_GUIDANCE
        ));
      } else {
        results.push(createResult(
          'API readiness',
          'blocked',
          `Failed to verify API /ready at ${options.runtimeState.apiUrl}.`,
          error instanceof Error ? error.message : String(error)
        ));
      }
    }
  } else {
    results.push(createResult(
      'API readiness',
      'blocked',
      'No API base URL is available from local setup state or the environment.',
      'Run npm run setup -- --deploy, or set SHEETFLARE_BASE_URL before verification.'
    ));
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
