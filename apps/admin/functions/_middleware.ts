import { handleAuthenticatedRequest } from './_lib/security';
import type { AdminPagesEnv } from './_lib/env';

export function onRequest(context: {
  env: AdminPagesEnv;
  next: () => Promise<Response>;
  request: Request;
}) {
  return handleAuthenticatedRequest(context);
}
