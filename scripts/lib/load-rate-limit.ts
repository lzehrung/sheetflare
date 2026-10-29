export type RateLimitPressureAttempt = {
  status: number;
};

export type RateLimitPressureAssessment = {
  status: 'passed' | 'failed';
  first429At: number | null;
  notes: string[];
};

/**
 * Every request counts against a client bucket keyed by the `cf-connecting-ip` header
 * (`x-forwarded-for` is ignored), or a shared `bootstrap-admin` bucket for the bootstrap token.
 * A request with a valid API key also counts against that key's own `api-key:<id>` bucket, and
 * the first 429 comes from whichever bucket runs out first. One load runner shares one client
 * bucket, so it cannot show isolation between clients. This scenario therefore only measures
 * pressure on one principal and says so in the report.
 */
export function assessRateLimitPressure(attempts: readonly RateLimitPressureAttempt[]): RateLimitPressureAssessment {
  const firstLimitedIndex = attempts.findIndex((attempt) => attempt.status === 429);
  const first429At = firstLimitedIndex >= 0 ? firstLimitedIndex + 1 : null;
  const unexpectedStatuses = [...new Set(
    attempts
      .map((attempt) => attempt.status)
      .filter((status) => status !== 200 && status !== 429)
  )].sort((left, right) => left - right);

  const notes = [first429At ? `samePrincipalFirst429At=${first429At}` : 'samePrincipalFirst429At=not-hit'];
  if (unexpectedStatuses.length > 0) {
    notes.push(`unexpectedStatuses=${unexpectedStatuses.join(',')}`);
  }
  notes.push('single principal only: the Worker rate-limits by cf-connecting-ip and ignores x-forwarded-for, so cross-principal isolation needs distinct egress IPs and is not exercised here');

  return {
    status: unexpectedStatuses.length === 0 ? 'passed' : 'failed',
    first429At,
    notes
  };
}
