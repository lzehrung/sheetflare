import { describe, expect, it } from 'vitest';
import { createApiKeyInputSchema } from '../src';

describe('createApiKeyInputSchema', () => {
  it('rejects scopes that are not part of the supported runtime auth model', () => {
    expect(() => createApiKeyInputSchema.parse({
      name: 'unsupported',
      scopes: ['project:read']
    })).toThrow();

    expect(() => createApiKeyInputSchema.parse({
      name: 'unsupported',
      scopes: ['project:write']
    })).toThrow();

    expect(() => createApiKeyInputSchema.parse({
      name: 'unsupported',
      scopes: ['admin:logs']
    })).toThrow();
  });
});
