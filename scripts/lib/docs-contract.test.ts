import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requiredStagingSecrets } from './staging-secrets';

function readRepoFile(relativePath: string) {
  return readFile(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');
}

describe('contributor staging guide', () => {
  it('documents the Worker-hosted admin and no retired Pages target', async () => {
    const guide = await readRepoFile('contributor-staging.md');

    expect(guide).toContain('/admin/');
    expect(guide).not.toMatch(/pages\.dev/i);
    expect(guide).not.toContain('sheetflare-staging-admin');
    expect(guide).not.toContain('apps/admin/wrangler.staging.jsonc');
  });

  it('names every secret the staging workflow requires, and the workflow reads each one', async () => {
    const guide = await readRepoFile('contributor-staging.md');
    const workflow = await readRepoFile('.github/workflows/deploy-staging.yml');

    for (const name of requiredStagingSecrets) {
      expect(guide, `${name} missing from contributor-staging.md`).toContain(name);
      expect(workflow, `${name} missing from deploy-staging.yml`).toContain(`secrets.${name}`);
    }
  });
});

describe('GitHub workflows', () => {
  it.each(['ci.yml', 'deploy-staging.yml'])('%s pins every action to a full commit SHA', async (file) => {
    const workflow = await readRepoFile(`.github/workflows/${file}`);
    const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);

    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, `${file}: ${reference}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});

describe('manual Google service-account guide', () => {
  it('enables the Drive API alongside Sheets and deletes the temporary key in a finally block', async () => {
    const guide = await readRepoFile('docs/google-service-accounts.md');

    expect(guide).toContain('gcloud services enable sheets.googleapis.com drive.googleapis.com');
    expect(guide).toMatch(/try \{[\s\S]*keys create[\s\S]*\}\s*finally \{[\s\S]*Remove-Item -LiteralPath \$keyPath -Force/);
  });
});

describe('superseded plans', () => {
  it('marks the local admin cutover plan as superseded by the hosted admin plan', async () => {
    const plan = await readRepoFile('docs/local-admin-cutover-plan.md');
    const [head = ''] = plan.split('## Summary');

    expect(head).toMatch(/superseded/i);
    expect(head).toContain('hosted-admin-plan.md');
  });
});

describe('root package scripts', () => {
  it('uses the supported --workspaces flag rather than deprecated -ws', async () => {
    const manifest = await readRepoFile('package.json');

    expect(manifest).not.toMatch(/npm run -ws/);
    expect(manifest).toContain('npm run --workspaces test');
  });
});
