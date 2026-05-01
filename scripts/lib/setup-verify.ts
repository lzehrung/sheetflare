import { ScriptError } from './runtime';

type VerifyAdminPagesDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
};

type ProbeResult = {
  ok: boolean;
  status: number | null;
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
    return {
      ok: response.ok,
      status: response.status
    };
  } catch {
    return {
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

export function getAdminPagesVerificationUrls(siteUrl: string) {
  const normalizedSiteUrl = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  return [
    normalizedSiteUrl,
    `${normalizedSiteUrl}/docs`
  ];
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
  const verificationUrls = getAdminPagesVerificationUrls(options.siteUrl);

  let lastFailureMessage = `Admin Pages verification failed for ${options.siteUrl}.`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let allHealthy = true;

    for (const url of verificationUrls) {
      const result = await probeUrl(url, headers, fetchImpl);
      if (result.ok) {
        continue;
      }

      allHealthy = false;
      lastFailureMessage = describeProbeFailure(url, result.status);
      break;
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
