import { describe, expect, it } from 'vitest';
import { forEachWithConcurrency } from './concurrency';

describe('forEachWithConcurrency', () => {
  it('never runs more than the limit at once and visits every item', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const visited: number[] = [];

    await forEachWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      new AbortController().signal,
      async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        visited.push(item);
      }
    );

    expect(maxInFlight).toBe(4);
    expect(visited.sort((left, right) => left - right)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('stops starting new work after the signal aborts', async () => {
    const controller = new AbortController();
    const visited: number[] = [];

    await forEachWithConcurrency([1, 2, 3, 4, 5, 6], 2, controller.signal, async (item) => {
      visited.push(item);
      if (item === 2) {
        controller.abort();
      }
      await Promise.resolve();
    });

    expect(visited).toEqual([1, 2]);
  });

  it('handles an empty list', async () => {
    await expect(forEachWithConcurrency([], 4, new AbortController().signal, async () => undefined)).resolves.toBeUndefined();
  });
});
