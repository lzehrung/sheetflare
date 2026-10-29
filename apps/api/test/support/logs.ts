import { z } from 'zod';
import type { MockInstance } from 'vitest';

const jsonLogSchema = z.record(z.string(), z.unknown());

/** Structured gateway log lines (`console.info` / `console.error` with a JSON string) captured by a spy. */
export function readJsonLogs(spy: MockInstance<(...data: unknown[]) => void>) {
  return spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== 'string') {
      return [];
    }

    try {
      const parsed = jsonLogSchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}
