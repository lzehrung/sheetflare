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

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function isYamlRecord(value: YamlValue | undefined): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScalar(text: string): YamlValue {
  if (text === 'true' || text === 'false') {
    return text === 'true';
  }
  if (text === 'null') {
    return null;
  }
  if (/^-?\d+$/.test(text)) {
    return Number(text);
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
    || (text.startsWith('\'') && text.endsWith('\'') && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseSimpleYaml(source: string): YamlValue {
  const lines = source.split(/\r?\n/).flatMap((rawLine, index) => {
    if (rawLine.includes('\t')) {
      throw new Error(`dependabot.yml:${index + 1} must use spaces`);
    }
    if (/^\s*$/.test(rawLine) || /^\s*#/.test(rawLine)) {
      return [];
    }
    const match = /^( *)(\S.*)$/.exec(rawLine);
    const indentText = match?.[1];
    const text = match?.[2];
    if (indentText === undefined || !text) {
      throw new Error(`dependabot.yml:${index + 1} is not valid`);
    }
    if (indentText.length % 2 !== 0) {
      throw new Error(`dependabot.yml:${index + 1} has uneven indentation`);
    }
    return [{ indent: indentText.length, text, line: index + 1 }];
  });

  function fail(line: number, message: string): never {
    throw new Error(`dependabot.yml:${line} ${message}`);
  }

  function parseBlock(start: number, minIndent: number): { value: YamlValue; next: number } {
    const current = lines[start];
    if (!current || current.indent < minIndent) {
      return { value: null, next: start };
    }

    if (current.text.startsWith('- ')) {
      const items: YamlValue[] = [];
      let index = start;
      const indent = current.indent;
      while (index < lines.length) {
        const item = lines[index];
        if (!item || item.indent !== indent || !item.text.startsWith('- ')) {
          break;
        }
        const content = item.text.slice(2);
        index += 1;
        const separator = content.indexOf(':');
        if (separator === -1) {
          items.push(parseScalar(content.trim()));
          continue;
        }
        const key = content.slice(0, separator).trim();
        const rest = content.slice(separator + 1).trim();
        if (key.length === 0) {
          fail(item.line, 'has an empty key');
        }
        const record: { [key: string]: YamlValue } = {};
        if (rest.length > 0) {
          record[key] = parseScalar(rest);
        } else {
          const nested = parseBlock(index, indent + 1);
          record[key] = nested.value;
          index = nested.next;
        }
        const continued = lines[index];
        if (continued && continued.indent > indent) {
          const nested = parseBlock(index, indent + 1);
          if (!isYamlRecord(nested.value)) {
            fail(continued.line, 'must continue the list item with fields');
          }
          Object.assign(record, nested.value);
          index = nested.next;
        }
        items.push(record);
      }
      return { value: items, next: index };
    }

    const record: { [key: string]: YamlValue } = {};
    let index = start;
    const indent = current.indent;
    while (index < lines.length) {
      const field = lines[index];
      if (!field || field.indent !== indent || field.text.startsWith('- ')) {
        break;
      }
      const separator = field.text.indexOf(':');
      if (separator === -1) {
        fail(field.line, 'must be a key');
      }
      const key = field.text.slice(0, separator).trim();
      const rest = field.text.slice(separator + 1).trim();
      if (key.length === 0) {
        fail(field.line, 'has an empty key');
      }
      index += 1;
      if (rest.length === 0) {
        const nested = parseBlock(index, indent + 1);
        record[key] = nested.value;
        index = nested.next;
      } else {
        record[key] = parseScalar(rest);
      }
    }
    return { value: record, next: index };
  }

  const parsed = parseBlock(0, 0);
  if (parsed.next !== lines.length) {
    throw new Error('dependabot.yml has unparsed content');
  }
  return parsed.value;
}

function yamlStringList(value: YamlValue | undefined) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return value;
}

describe('Dependabot', () => {
  it('updates SHA-pinned actions weekly and groups npm minor and patch updates', async () => {
    const document = parseSimpleYaml(await readRepoFile('.github/dependabot.yml'));
    if (!isYamlRecord(document) || !Array.isArray(document.updates)) {
      throw new Error('dependabot.yml must be a versioned updates list');
    }

    expect(document.version).toBe(2);
    const updates = document.updates.filter(isYamlRecord);
    expect(updates).toHaveLength(document.updates.length);

    const githubActions = updates.find((update) => update['package-ecosystem'] === 'github-actions');
    const npm = updates.find((update) => update['package-ecosystem'] === 'npm');
    expect(githubActions?.directory).toBe('/');
    expect(isYamlRecord(githubActions?.schedule) ? githubActions.schedule.interval : null).toBe('weekly');
    expect(npm?.directory).toBe('/');
    expect(isYamlRecord(npm?.schedule) ? npm.schedule.interval : null).toBe('weekly');

    const groups = isYamlRecord(npm?.groups) ? npm.groups : null;
    const minorAndPatch = groups && isYamlRecord(groups['minor-and-patch']) ? groups['minor-and-patch'] : null;
    expect(yamlStringList(minorAndPatch?.patterns)).toEqual(['*']);
    expect(yamlStringList(minorAndPatch?.['update-types'])).toEqual(['minor', 'patch']);
  });
});

describe('root package scripts', () => {
  it('uses the supported --workspaces flag rather than deprecated -ws', async () => {
    const manifest = await readRepoFile('package.json');

    expect(manifest).not.toMatch(/npm run -ws/);
    expect(manifest).toContain('npm run --workspaces test');
  });
});
