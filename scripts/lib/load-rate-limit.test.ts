import { describe, expect, it } from 'vitest';
import { assessRateLimitPressure } from './load-rate-limit';

describe('assessRateLimitPressure', () => {
  it('passes and reports the 1-based request that first hit the limit', () => {
    const result = assessRateLimitPressure([{ status: 200 }, { status: 200 }, { status: 429 }]);

    expect(result.status).toBe('passed');
    expect(result.first429At).toBe(3);
    expect(result.notes).toContain('samePrincipalFirst429At=3');
  });

  it('passes but reports not-hit when the configured volume never reached the limit', () => {
    const result = assessRateLimitPressure([{ status: 200 }, { status: 200 }]);

    expect(result.status).toBe('passed');
    expect(result.first429At).toBeNull();
    expect(result.notes).toContain('samePrincipalFirst429At=not-hit');
  });

  it('fails when a request returns anything other than 200 or 429', () => {
    const result = assessRateLimitPressure([{ status: 200 }, { status: 401 }, { status: -1 }]);

    expect(result.status).toBe('failed');
    expect(result.notes).toContain('unexpectedStatuses=-1,401');
  });

  it('never claims separation between principals, which the Worker keys by cf-connecting-ip', () => {
    const result = assessRateLimitPressure([{ status: 200 }]);

    expect(result.notes.join(' ')).toContain('cf-connecting-ip');
    expect(result.notes.join(' ')).not.toMatch(/distributedPrincipals|separation (verified|proven|passed)/i);
  });
});
