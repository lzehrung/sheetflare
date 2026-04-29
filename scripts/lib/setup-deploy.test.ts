import { describe, expect, it } from 'vitest';
import { buildAdminDeployCommand, buildApiDeployCommand, getAdminPagesProjectName } from './setup-deploy';

describe('setup deploy command builders', () => {
  it('builds the pinned API deploy command', () => {
    expect(buildApiDeployCommand()).toEqual(['wrangler@4.85.0', 'deploy', '--config', 'wrangler.jsonc']);
  });

  it('builds the pinned admin pages deploy command', () => {
    expect(buildAdminDeployCommand('sheetflare-admin')).toEqual([
      'wrangler@4.85.0',
      'pages',
      'deploy',
      'dist',
      '--project-name',
      'sheetflare-admin',
      '--branch',
      'main',
      '--commit-dirty=true'
    ]);
  });

  it('uses the generic public Pages project name', () => {
    expect(getAdminPagesProjectName()).toBe('sheetflare-admin');
  });
});
