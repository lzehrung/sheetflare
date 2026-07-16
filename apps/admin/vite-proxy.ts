import type { ClientRequest, IncomingMessage } from 'node:http';
import { adminCredentialHeaderName } from './src/auth';

export const adminHost = '127.0.0.1';
export const adminPort = 4173;

const defaultAdminApiTarget = 'http://127.0.0.1:8787';
const loopbackHostnames: Readonly<Record<string, true>> = {
  '127.0.0.1': true,
  localhost: true,
  '::1': true,
  '[::1]': true
};

function validateAdminApiTarget(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `Invalid admin API target from ${source} (${JSON.stringify(value)}): expected an absolute URL. Remote targets require HTTPS because the proxy forwards the admin credential as Bearer.`
    );
  }

  const isLoopbackHttp = url.protocol === 'http:' && loopbackHostnames[url.hostname] === true;
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error(
      `Invalid admin API target from ${source} (${JSON.stringify(value)}): remote targets require HTTPS because the proxy forwards the admin credential as Bearer.`
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `Invalid admin API target from ${source} (${JSON.stringify(value)}): credentials, query strings, and fragments are not allowed.`
    );
  }

  return value;
}

function readStateApiTarget(localStateText: string | null): string | null {
  if (localStateText === null) {
    return null;
  }

  let localState: unknown;
  try {
    localState = JSON.parse(localStateText);
  } catch {
    return null;
  }

  if (typeof localState !== 'object' || localState === null || !('apiUrl' in localState)) {
    return null;
  }

  const apiUrl = localState.apiUrl;
  if (typeof apiUrl !== 'string') {
    return null;
  }

  const trimmedApiUrl = apiUrl.trim();
  return trimmedApiUrl.length > 0 ? trimmedApiUrl : null;
}

export function resolveAdminApiTarget(
  envValue: string | undefined,
  localStateText: string | null
): string {
  const trimmedEnvValue = envValue?.trim();
  if (trimmedEnvValue) {
    return validateAdminApiTarget(trimmedEnvValue, 'SHEETFLARE_API_BASE_URL');
  }

  const stateApiTarget = readStateApiTarget(localStateText);
  if (stateApiTarget !== null) {
    return validateAdminApiTarget(stateApiTarget, 'local state apiUrl');
  }

  return defaultAdminApiTarget;
}

const forwardedRequestHeaderNames: Readonly<Record<string, true>> = {
  accept: true,
  'content-length': true,
  'content-type': true,
  host: true
};

export function rewriteAdminProxyRequest(
  proxyRequest: Pick<ClientRequest, 'setHeader' | 'removeHeader'>,
  request: Pick<IncomingMessage, 'headers'>
): void {
  for (const headerName of Object.keys(request.headers)) {
    if (!forwardedRequestHeaderNames[headerName]) {
      proxyRequest.removeHeader(headerName);
    }
  }

  proxyRequest.removeHeader('authorization');
  proxyRequest.removeHeader(adminCredentialHeaderName);

  const credential = request.headers[adminCredentialHeaderName];
  if (typeof credential === 'string' && credential.length > 0) {
    proxyRequest.setHeader('authorization', `Bearer ${credential}`);
  }
}

export function rewriteAdminProxyResponse(response: Pick<IncomingMessage, 'headers'>): void {
  response.headers['cache-control'] = 'no-store';
  delete response.headers['set-cookie'];
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ');

export const adminResponseHeaders = Object.freeze({
  'Content-Security-Policy': contentSecurityPolicy,
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow'
});
