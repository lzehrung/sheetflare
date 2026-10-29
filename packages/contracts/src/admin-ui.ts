export const adminUiBasePath = '/admin/';
export const adminSessionPath = '/__sheetflare/admin-session';

export type AdminSessionResponse = {
  serverCredential: boolean;
};

export type AdminUiHeaderOptions = {
  hotReloadOrigin?: string;
};

export function buildAdminUiHeaders(options: AdminUiHeaderOptions = {}): Readonly<Record<string, string>> {
  const connectSources = options.hotReloadOrigin ? `'self' ${options.hotReloadOrigin}` : "'self'";
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
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
}
