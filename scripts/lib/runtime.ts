type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptError';
  }
}

export function getEnv(name: string) {
  return process.env[name]?.trim() || null;
}

export function requireEnv(name: string, guidance?: string) {
  const value = getEnv(name);
  if (!value) {
    throw new ScriptError(`Missing required environment variable ${name}.${guidance ? ` ${guidance}` : ''}`);
  }

  return value;
}

export function getFirstEnv(...names: string[]) {
  for (const name of names) {
    const value = getEnv(name);
    if (value) {
      return value;
    }
  }

  return null;
}

export function shouldShowSecrets() {
  const raw = process.env.SHEETFLARE_SHOW_SECRETS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function redactSecret(value: string) {
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function requireAdminCredential() {
  const credential = getFirstEnv('SHEETFLARE_ADMIN_CREDENTIAL', 'SHEETFLARE_ADMIN_BEARER');
  if (!credential) {
    throw new ScriptError('Missing required environment variable SHEETFLARE_ADMIN_CREDENTIAL (or legacy SHEETFLARE_ADMIN_BEARER).');
  }

  return credential;
}

export function readJsonEnv<T>(name: string): T {
  const value = requireEnv(name);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ScriptError(`Environment variable ${name} must contain valid JSON.`);
  }
}

export function joinUrl(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function summarizeBody(bodyText: string) {
  const normalized = bodyText.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237)}...`;
}

function formatRequestLabel(options: { method?: HttpMethod; path: string }) {
  return `${options.method ?? 'GET'} ${options.path}`;
}

function formatExpectedStatus(expectedStatus: number | number[]) {
  return Array.isArray(expectedStatus) ? expectedStatus.join(' or ') : String(expectedStatus);
}

export async function requestJson<T>(options: {
  baseUrl: string;
  path: string;
  method?: HttpMethod;
  bearer?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  expectedStatus?: number | number[];
}) {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      ...(options.headers ?? {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {})
    }
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(joinUrl(options.baseUrl, options.path), init);

  const text = await response.text();

  let expectedStatuses: number[] | null = null;
  if (options.expectedStatus !== undefined) {
    expectedStatuses = Array.isArray(options.expectedStatus)
      ? options.expectedStatus
      : [options.expectedStatus];
  }
  if (expectedStatuses && !expectedStatuses.includes(response.status)) {
    const requestId = response.headers.get('x-request-id');
    const bodySummary = text.trim().length > 0 ? summarizeBody(text) : null;
    throw new ScriptError(
      [
        `Expected ${formatRequestLabel(options)} to return ${formatExpectedStatus(expectedStatuses)}, received ${response.status}.`,
        requestId ? `requestId=${requestId}` : null,
        bodySummary ? `body=${bodySummary}` : null
      ].filter(Boolean).join(' ')
    );
  }

  if (text.length === 0) {
    return {
      response,
      data: null
    };
  }

  try {
    return {
      response,
      data: JSON.parse(text) as T
    };
  } catch {
    throw new ScriptError(
      `Expected ${formatRequestLabel(options)} to return JSON, received invalid JSON body: ${summarizeBody(text)}`
    );
  }

}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ScriptError(message);
  }
}

export function assertPresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new ScriptError(message);
  }

  return value;
}

export function logStep(message: string) {
  console.log(`\n[step] ${message}`);
}

export function logSuccess(message: string) {
  console.log(`[ok] ${message}`);
}

export function logSetupStep(message: string) {
  console.log(`\nSetup: ${message}`);
}

export function logSetupSuccess(message: string) {
  console.log(`Done: ${message}`);
}
