/**
 * Incremental collection utility for parallel agent execution.
 * Replaces raw Promise.allSettled with callbacks as each promise resolves.
 */

export interface IncrementalOpts<T> {
  onResult: (result: T, index: number, total: number) => Promise<void>;
  onPartialReady?: (completed: T[], remaining: number) => Promise<void>;
  partialThreshold?: number;
}

export async function collectIncrementally<T>(
  promises: Promise<T>[],
  opts: IncrementalOpts<T>,
): Promise<PromiseSettledResult<T>[]> {
  const total = promises.length;
  if (total === 0) return [];

  const threshold = opts.partialThreshold ?? 0.5;
  const completed: T[] = [];
  let failedCount = 0;
  let partialFired = false;

  const checkPartialReady = async () => {
    const settledCount = completed.length + failedCount;
    if (
      !partialFired &&
      opts.onPartialReady &&
      completed.length >= Math.ceil(total * threshold) &&
      settledCount < total
    ) {
      partialFired = true;
      await opts.onPartialReady(
        [...completed],
        total - settledCount,
      ).catch(() => {});
    }
  };

  const wrapped = promises.map((p, i) =>
    p.then(
      async (value) => {
        completed.push(value);
        await opts.onResult(value, i, total).catch(() => {});
        await checkPartialReady();
        return value;
      },
    ).catch(async (err) => {
      failedCount++;
      await checkPartialReady();
      throw err;
    }),
  );

  return Promise.allSettled(wrapped);
}
