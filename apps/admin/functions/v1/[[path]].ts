import type { AdminPagesEnv } from '../_lib/env';
import { proxyToApi } from '../_lib/api-proxy';

export function onRequest(context: { env: AdminPagesEnv; request: Request }) {
  return proxyToApi(context);
}
