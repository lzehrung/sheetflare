import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export interface CloudflareEnv {
  CONTROL_PLANE_DO: DurableObjectNamespace;
  PROJECT_DO: DurableObjectNamespace;
  TABLE_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  ADMIN_BEARER_TOKEN?: string;
}
