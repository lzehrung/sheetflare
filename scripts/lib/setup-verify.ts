import { ScriptError } from './runtime';

type VerifyAdminPagesDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
};

type ProbeResult = {
  body: string | null;
  contentType: string | null;
  ok: boolean;
  status: number | null;
  headers: Headers | null;
};

type VerificationProbe = {
  acceptedStatuses?: number[];
  expectedContentTypePrefix?: string;
  expectedStatus: number;
  name: string;
  path: string;
  requiredBodySnippet?: string;
};

function createBasicAuthorizationHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function createHeaders(username: string, password: string) {
  return {
    authorization: createBasicAuthorizationHeader(username, password)
  };
}

async function probeUrl(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'manual'
    });
    const body = await response.text();
    return {
      body,
      contentType: response.headers.get('content-type'),
      headers: response.headers,
      ok: response.ok,
      status: response.status
    };
  } catch {
    return {
      body: null,
      contentType: null,
      headers: null,
      ok: false,
      status: null
    };
  }
}

function describeProbeFailure(url: string, status: number | null) {
  if (status === null) {
    return `Admin Pages verification failed for ${url}. The request could not reach the deployed site.`;
  }

  return `Admin Pages verification failed for ${url} with status ${status}.`;
}

function describeUnexpectedContentType(url: string, contentType: string | null, expectedPrefix: string) {
  return [
    `Admin Pages verification failed for ${url}.`,
    `Expected a ${expectedPrefix} response, received ${contentType ?? 'no content-type header'}.`
  ].join(' ');
}

function describeMissingBodySnippet(url: string, snippet: string) {
  return `Admin Pages verification failed for ${url}. The response body did not include the expected marker ${JSON.stringify(snippet)}.`;
}

function describeMissingAuthChallenge(url: string) {
  return `Admin Pages verification failed for ${url}. The unauthenticated response did not include a Basic auth challenge.`;
}

function createVerificationProbes(): VerificationProbe[] {
  return [
    {
      expectedContentTypePrefix: 'text/html',
      expectedStatus: 200,
      name: 'admin root',
      path: '',
      requiredBodySnippet: '<title>Sheetflare Admin</title>'
    },
    {
      expectedContentTypePrefix: 'application/json',
      expectedStatus: 200,
      acceptedStatuses: [200, 503],
      name: 'proxied /ready',
      path: '/ready',
      requiredBodySnippet: '"service":"sheetflare-api"'
    },
    {
      expectedContentTypePrefix: 'text/html',
      expectedStatus: 200,
      name: 'proxied /docs',
      path: '/docs',
      requiredBodySnippet: '<title>Sheetflare API Docs</title>'
    },
    {
      expectedContentTypePrefix: 'application/json',
      expectedStatus: 401,
      name: 'proxied admin API route',
      path: '/v1/admin/projects',
      requiredBodySnippet: '"code":"UNAUTHORIZED"'
    }
  ];
}

export function getAdminPagesVerificationUrls(siteUrl: string) {
  const normalizedSiteUrl = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  return createVerificationProbes().map((probe) => `${normalizedSiteUrl}${probe.path}`);
}

export async function verifyAdminPagesDeployment(
  options: {
    password: string;
    retryDelayMs?: number;
    siteUrl: string;
    username: string;
    maxAttempts?: number;
  },
  dependencies: VerifyAdminPagesDependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const maxAttempts = options.maxAttempts ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const headers = createHeaders(options.username, options.password);
  const normalizedSiteUrl = options.siteUrl.endsWith('/') ? options.siteUrl.slice(0, -1) : options.siteUrl;
  const verificationProbes = createVerificationProbes();

  let lastFailureMessage = `Admin Pages verification failed for ${options.siteUrl}.`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let allHealthy = true;
    const unauthenticatedRootUrl = normalizedSiteUrl;
    const unauthenticatedRootResult = await probeUrl(unauthenticatedRootUrl, {}, fetchImpl);
    if (unauthenticatedRootResult.status !== 401) {
      allHealthy = false;
      lastFailureMessage = describeProbeFailure(unauthenticatedRootUrl, unauthenticatedRootResult.status);
    } else {
      const authChallenge = unauthenticatedRootResult.headers?.get('www-authenticate')?.toLowerCase() ?? '';
      if (!authChallenge.startsWith('basic ')) {
        allHealthy = false;
        lastFailureMessage = describeMissingAuthChallenge(unauthenticatedRootUrl);
      }
    }

    if (!allHealthy) {
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
      continue;
    }

    for (const probe of verificationProbes) {
      const url = `${normalizedSiteUrl}${probe.path}`;
      const result = await probeUrl(url, headers, fetchImpl);
      const acceptedStatuses = probe.acceptedStatuses ?? [probe.expectedStatus];
      if (!acceptedStatuses.includes(result.status ?? Number.NaN)) {
        allHealthy = false;
        lastFailureMessage = describeProbeFailure(url, result.status);
        break;
      }

      if (probe.expectedContentTypePrefix && !result.contentType?.toLowerCase().startsWith(probe.expectedContentTypePrefix)) {
        allHealthy = false;
        lastFailureMessage = describeUnexpectedContentType(url, result.contentType, probe.expectedContentTypePrefix);
        break;
      }

      if (probe.requiredBodySnippet && !result.body?.includes(probe.requiredBodySnippet)) {
        allHealthy = false;
        lastFailureMessage = describeMissingBodySnippet(url, probe.requiredBodySnippet);
        break;
      }
    }

    if (allHealthy) {
      return;
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  throw new ScriptError(lastFailureMessage);
}
