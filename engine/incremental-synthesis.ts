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
  let partialFired = false;

  const wrapped = promises.map((p, i) =>
    p.then(
      async (value) => {
        completed.push(value);
        await opts.onResult(value, i, total).catch(() => {});

        if (
          !partialFired &&
          opts.onPartialReady &&
          completed.length >= Math.ceil(total * threshold) &&
          completed.length < total
        ) {
          partialFired = true;
          await opts.onPartialReady(
            [...completed],
            total - completed.length,
          ).catch(() => {});
        }

        return value;
      },
    ),
  );

  return Promise.allSettled(wrapped);
}
