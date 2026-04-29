import { describe, expect, it } from 'vitest';
import { buildAdminSecretCommands, buildApiSecretCommands } from './setup-secrets';

describe('setup secret command builders', () => {
  it('builds worker secret put commands against the provided wrangler config', () => {
    expect(buildApiSecretCommands('apps/api/wrangler.jsonc')).toEqual({
      googlePrivateKey: ['wrangler', 'secret', 'put', 'GOOGLE_PRIVATE_KEY', '--config', 'apps/api/wrangler.jsonc'],
      adminBearerToken: ['wrangler', 'secret', 'put', 'ADMIN_BEARER_TOKEN', '--config', 'apps/api/wrangler.jsonc']
    });
  });

  it('builds pages secret put commands against the provided project name', () => {
    expect(buildAdminSecretCommands('sheetflare-admin')).toEqual({
      username: ['wrangler', 'pages', 'secret', 'put', 'ADMIN_UI_USERNAME', '--project-name', 'sheetflare-admin'],
      password: ['wrangler', 'pages', 'secret', 'put', 'ADMIN_UI_PASSWORD', '--project-name', 'sheetflare-admin']
    });
  });
});
