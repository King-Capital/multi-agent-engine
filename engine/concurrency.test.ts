import { test, expect, describe } from "bun:test";
import { ConcurrencyLimiter } from "./concurrency";

describe("ConcurrencyLimiter", () => {
  test("constructor rejects max < 1", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow("max must be >= 1");
    expect(() => new ConcurrencyLimiter(-5)).toThrow("max must be >= 1");
  });

  test("allows up to max concurrent tasks", async () => {
    const limiter = new ConcurrencyLimiter(3);
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, (_, i) =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        // Yield to let other tasks attempt to start
        await new Promise((r) => setTimeout(r, 10));
        running--;
        return i;
      })
    );

    const results = await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("queued tasks run when slots free up", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];

    const t1 = limiter.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
    });
    const t2 = limiter.run(async () => {
      order.push(2);
    });
    const t3 = limiter.run(async () => {
      order.push(3);
    });

    await Promise.all([t1, t2, t3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("release properly decrements active count", async () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.currentActive).toBe(0);

    await limiter.acquire();
    expect(limiter.currentActive).toBe(1);

    await limiter.acquire();
    expect(limiter.currentActive).toBe(2);

    limiter.release();
    expect(limiter.currentActive).toBe(1);

    limiter.release();
    expect(limiter.currentActive).toBe(0);
  });

  test("queueLength reflects waiting tasks", async () => {
    const limiter = new ConcurrencyLimiter(1);
    expect(limiter.queueLength).toBe(0);

    await limiter.acquire();
    expect(limiter.queueLength).toBe(0);

    // These will queue since slot is taken
    const p1 = limiter.acquire();
    const p2 = limiter.acquire();
    expect(limiter.queueLength).toBe(2);

    limiter.release(); // dequeues p1
    await p1;
    expect(limiter.queueLength).toBe(1);

    limiter.release(); // dequeues p2
    await p2;
    expect(limiter.queueLength).toBe(0);

    // Clean up
    limiter.release();
    limiter.release();
  });

  test("works with Promise.allSettled pattern", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, (_, i) =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (i === 3) throw new Error("intentional failure");
        return i;
      })
    );

    const settled = await Promise.allSettled(tasks);
    expect(peak).toBeLessThanOrEqual(2);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(1);
  });

  test("releases slot even when task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);

    try {
      await limiter.run(async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // Slot should be available again
    expect(limiter.currentActive).toBe(0);

    // Should be able to acquire immediately
    const result = await limiter.run(async () => "ok");
    expect(result).toBe("ok");
  });

  test("handles max=1 as a mutex", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      })
    );

    await Promise.all(tasks);
    expect(peak).toBe(1);
  });
});
