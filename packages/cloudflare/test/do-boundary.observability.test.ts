import { readFile } from 'node:fs/promises';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const workerConfigSchema = z.object({
  observability: z.object({ enabled: z.boolean() }).optional()
});

// The Durable Objects report failures such as drive.reindex.failed only through console logs, which a Worker keeps
// only when Workers Logs is enabled in its Wrangler config.
describe('Workers Logs for Durable Object events', () => {
  it.each(['wrangler.jsonc', 'wrangler.staging.jsonc'])('is enabled in apps/api/%s', async (file) => {
    const text = await readFile(new URL(`../../../apps/api/${file}`, import.meta.url), 'utf8');
    const { config, error } = ts.parseConfigFileTextToJson(file, text);

    expect(error).toBeUndefined();
    expect(workerConfigSchema.parse(config).observability?.enabled).toBe(true);
  });
});
