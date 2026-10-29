export const adminUiBasePath = '/admin/';
export const adminSessionPath = '/__sheetflare/admin-session';

export type AdminSessionResponse = {
  serverCredential: boolean;
};

export type AdminUiHeaderOptions = {
  hotReloadOrigin?: string;
  cache?: 'no-store' | 'immutable';
};

export function buildAdminUiHeaders(options: AdminUiHeaderOptions = {}): Readonly<Record<string, string>> {
  const connectSources = options.hotReloadOrigin ? `'self' ${options.hotReloadOrigin}` : "'self'";
  let cacheControl = 'no-store';
  if (options.cache === 'immutable') {
    cacheControl = 'public, max-age=31536000, immutable';
  }
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ].join('; ');

  return Object.freeze({
    'Content-Security-Policy': contentSecurityPolicy,
    'Cache-Control': cacheControl,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
}
