import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export interface CloudflareEnv {
  CONTROL_PLANE_DO: DurableObjectNamespace;
  PROJECT_DO: DurableObjectNamespace;
  TABLE_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CREDENTIALS_JSON?: string;
  GOOGLE_DRIVE_WEBHOOK_SECRET?: string;
  ADMIN_BEARER_TOKEN?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  TABLE_MAX_FULL_SCAN_ROWS?: string;
  SHEETFLARE_ALLOWED_ORIGINS?: string;
}
