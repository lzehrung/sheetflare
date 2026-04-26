import { describe, expect, it } from 'vitest';
import { type RateLimitDoResponse } from '@sheetflare/contracts';
import { RateLimitDO, doRpc } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';

describe('RateLimitDO', () => {
  it('tracks independent windows per bucket key', async () => {
    const env = {} as Record<string, never>;
    const namespace = createDurableObjectNamespace(env, RateLimitDO);
    const stub = namespace.get(namespace.idFromName('global-rate-limit'));

    const adminFirst = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 1_000
    });
    const adminSecond = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 2_000
    });
    const dataFirst = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'data:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 2_000
    });

    expect((adminFirst as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(true);
    expect((adminSecond as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(false);
    expect((dataFirst as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(true);
  });
});
