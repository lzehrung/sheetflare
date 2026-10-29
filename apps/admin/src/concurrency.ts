/**
 * Runs `worker` over `items` with at most `limit` calls in flight, in order. Stops starting new work once
 * `signal` aborts. Workers must handle their own failures; a thrown error rejects the whole run.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runLane() {
    while (!signal.aborted && nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runLane));
}
