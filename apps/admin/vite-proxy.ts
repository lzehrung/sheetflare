import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { adminSessionPath, buildAdminUiHeaders, type AdminSessionResponse } from '@sheetflare/contracts';
import { adminRequestHeaderName, normalizeAdminCredential } from './src/auth';

export const adminHost = '127.0.0.1';
export const adminPort = 4173;
const adminOrigin = `http://${adminHost}:${adminPort}`;

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

export function resolveServerAdminCredential(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const name of ['SHEETFLARE_ADMIN_CREDENTIAL', 'SHEETFLARE_ADMIN_BEARER']) {
    const credential = normalizeAdminCredential(env[name] ?? '');
    if (credential === null) {
      continue;
    }
    if (!/^[\x21-\x7e]+$/.test(credential)) {
      throw new Error(`Invalid ${name}: admin credentials must contain only visible ASCII characters.`);
    }
    return credential;
  }

  return null;
}

function isAdminUiRequest(headers: IncomingHttpHeaders): boolean {
  if (headers[adminRequestHeaderName] !== '1') {
    return false;
  }
  if (headers.origin !== undefined && headers.origin !== adminOrigin) {
    return false;
  }

  const fetchSite = headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin';
}

// Browsers always send Sec-Fetch-Site and scripts cannot forge it. A local non-browser process can set
// the admin marker header, so only browser-attested same-origin requests may borrow the server credential.
function hasSameOriginFetchMetadata(headers: IncomingHttpHeaders): boolean {
  return headers['sec-fetch-site'] === 'same-origin';
}

const forwardedRequestHeaderNames: Readonly<Record<string, true>> = {
  accept: true,
  'content-length': true,
  'content-type': true,
  host: true
};

export function rewriteAdminProxyRequest(
  proxyRequest: Pick<ClientRequest, 'setHeader' | 'removeHeader'>,
  request: Pick<IncomingMessage, 'headers'>,
  serverCredential: string | null
): void {
  for (const headerName of Object.keys(request.headers)) {
    if (!forwardedRequestHeaderNames[headerName]) {
      proxyRequest.removeHeader(headerName);
    }
  }

  proxyRequest.removeHeader('authorization');

  if (!isAdminUiRequest(request.headers)) {
    return;
  }

  const browserAuthorization = request.headers.authorization;
  const browserToken = browserAuthorization?.startsWith('Bearer ')
    ? browserAuthorization.slice('Bearer '.length).trim()
    : '';
  const fallbackCredential = hasSameOriginFetchMetadata(request.headers) ? serverCredential : null;
  const credential = browserToken.length > 0 ? browserToken : fallbackCredential;
  if (credential !== null) {
    proxyRequest.setHeader('authorization', `Bearer ${credential}`);
  }
}

type SessionHttpResponse = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
};

export function handleAdminSessionRequest(
  request: Pick<IncomingMessage, 'method' | 'url'>,
  response: SessionHttpResponse,
  serverCredentialAvailable: boolean
): boolean {
  if (request.url !== adminSessionPath) {
    return false;
  }

  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET');
    response.end();
    return true;
  }

  const body: AdminSessionResponse = { serverCredential: serverCredentialAvailable };
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
  return true;
}

export function rewriteAdminProxyResponse(response: Pick<IncomingMessage, 'headers'>): void {
  response.headers['cache-control'] = 'no-store';
  delete response.headers['set-cookie'];
}

export const adminResponseHeaders = buildAdminUiHeaders({ hotReloadOrigin: `ws://${adminHost}:${adminPort}` });
