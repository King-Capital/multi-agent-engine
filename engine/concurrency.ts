/**
 * Semaphore-based concurrency limiter for capping parallel agent spawns.
 * Used to prevent OOM on smaller machines when many agents run simultaneously.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error(`ConcurrencyLimiter max must be >= 1, got ${max}`);
  }

  get currentActive(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }

  /**
   * Run an async function with concurrency limiting.
   * Acquires a slot before running, releases after completion or error.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
