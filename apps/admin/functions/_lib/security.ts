import type { AdminPagesEnv } from './env';

export const adminSiteRealm = 'Sheetflare Admin';

const textEncoder = new TextEncoder();
const securityHeaders = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "form-action 'self'"
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow, noarchive'
} as const;

interface BasicCredentials {
  password: string;
  username: string;
}

export interface MiddlewareContext {
  env: AdminPagesEnv;
  next: () => Promise<Response>;
  request: Request;
}

function applySecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function createBasicAuthChallengeResponse(message: string, status = 401) {
  return applySecurityHeaders(
    new Response(message, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': `Basic realm="${adminSiteRealm}", charset="UTF-8"`
      },
      status
    })
  );
}

function createConfigurationErrorResponse(message: string) {
  return applySecurityHeaders(
    new Response(message, {
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8'
      },
      status: 500
    })
  );
}

function decodeBasicCredentials(encodedValue: string): BasicCredentials | null {
  try {
    const decodedValue = atob(encodedValue);
    const separatorIndex = decodedValue.indexOf(':');
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decodedValue.slice(0, separatorIndex),
      password: decodedValue.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function parseBasicAuthorizationHeader(headerValue: string | null): BasicCredentials | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, encodedValue] = headerValue.split(' ', 2);
  if (scheme !== 'Basic' || !encodedValue) {
    return null;
  }

  return decodeBasicCredentials(encodedValue);
}

function constantTimeEquals(left: string, right: string) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

function isAuthorizedRequest(request: Request, env: AdminPagesEnv) {
  const configuredUsername = env.ADMIN_UI_USERNAME?.trim();
  const configuredPassword = env.ADMIN_UI_PASSWORD?.trim();

  if (!configuredUsername || !configuredPassword) {
    return { ok: false as const, reason: 'misconfigured' as const };
  }

  const providedCredentials = parseBasicAuthorizationHeader(request.headers.get('authorization'));
  if (!providedCredentials) {
    return { ok: false as const, reason: 'missing' as const };
  }

  const usernameMatches = constantTimeEquals(providedCredentials.username, configuredUsername);
  const passwordMatches = constantTimeEquals(providedCredentials.password, configuredPassword);

  return usernameMatches && passwordMatches
    ? { ok: true as const }
    : { ok: false as const, reason: 'invalid' as const };
}

export async function handleAuthenticatedRequest(context: MiddlewareContext) {
  const authorizationResult = isAuthorizedRequest(context.request, context.env);
  if (!authorizationResult.ok) {
    return authorizationResult.reason === 'misconfigured'
      ? createConfigurationErrorResponse('Admin UI auth is not configured.')
      : createBasicAuthChallengeResponse('Admin UI authentication required.');
  }

  return applySecurityHeaders(await context.next());
}
