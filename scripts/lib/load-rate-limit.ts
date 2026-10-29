export type RateLimitPressureAttempt = {
  status: number;
};

export type RateLimitPressureAssessment = {
  status: 'passed' | 'failed';
  first429At: number | null;
  notes: string[];
};

/**
 * The Worker keys rate limits by the `cf-connecting-ip` header (or a shared `bootstrap-admin`
 * principal for the bootstrap token). It ignores `x-forwarded-for`, and API keys do not get
 * their own bucket, so a single load runner cannot synthesize separate principals. This scenario
 * therefore only measures pressure on one principal and says so in the report.
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
