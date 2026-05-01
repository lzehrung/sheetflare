import { adminCredentialHeaderName } from '../../src/auth';
import type { AdminPagesEnv } from './env';

export interface ProxyContext {
  env: AdminPagesEnv;
  request: Request;
}

function createProxyErrorResponse(message: string, status: number) {
  return new Response(message, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8'
    },
    status
  });
}

function resolveApiBaseUrl(env: AdminPagesEnv) {
  const configuredValue = env.SHEETFLARE_API_BASE_URL?.trim();
  if (!configuredValue) {
    throw new Error('SHEETFLARE_API_BASE_URL is not configured for the admin Pages project.');
  }

  const targetUrl = new URL(configuredValue);
  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    throw new Error('SHEETFLARE_API_BASE_URL must use http or https.');
  }

  return targetUrl;
}

function copyAllowedRequestHeaders(request: Request) {
  const headers = new Headers();
  const allowedHeaderNames = ['accept', 'content-type'];
  for (const headerName of allowedHeaderNames) {
    const headerValue = request.headers.get(headerName);
    if (headerValue) {
      headers.set(headerName, headerValue);
    }
  }

  const credential = request.headers.get(adminCredentialHeaderName);
  if (credential) {
    headers.set('authorization', `Bearer ${credential}`);
  }

  return headers;
}

function createProxyTargetUrl(request: Request, baseUrl: URL) {
  const requestUrl = new URL(request.url);
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, baseUrl);
}

function createForwardRequest(request: Request, baseUrl: URL) {
  const init: RequestInit = {
    headers: copyAllowedRequestHeaders(request),
    method: request.method,
    redirect: 'manual'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return new Request(createProxyTargetUrl(request, baseUrl), init);
}

function copyResponseHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return headers;
}

export async function proxyToApi(context: ProxyContext) {
  let baseUrl: URL;
  try {
    baseUrl = resolveApiBaseUrl(context.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Admin Pages upstream configuration is invalid.';
    return createProxyErrorResponse(message, 500);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(createForwardRequest(context.request, baseUrl));
  } catch (error) {
    const message = error instanceof Error
      ? `Admin Pages could not reach the Sheetflare API upstream: ${error.message}`
      : 'Admin Pages could not reach the Sheetflare API upstream.';
    return createProxyErrorResponse(message, 502);
  }

  return new Response(upstreamResponse.body, {
    headers: copyResponseHeaders(upstreamResponse),
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText
  });
}
