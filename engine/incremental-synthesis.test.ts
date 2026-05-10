import { describe, test, expect } from "bun:test";
import { collectIncrementally } from "./incremental-synthesis";

describe("collectIncrementally", () => {
  test("returns all results like Promise.allSettled", async () => {
    const promises = [
      Promise.resolve("a"),
      Promise.resolve("b"),
      Promise.resolve("c"),
    ];

    const results = await collectIncrementally(promises, {
      onResult: async () => {},
    });

    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  test("calls onResult as each promise resolves", async () => {
    const order: number[] = [];
    const promises = [
      Bun.sleep(50).then(() => "slow"),
      Promise.resolve("fast"),
      Bun.sleep(25).then(() => "medium"),
    ];

    await collectIncrementally(promises, {
      onResult: async (_result, index) => {
        order.push(index);
      },
    });

    expect(order.length).toBe(3);
    // "fast" (index 1) should be first
    expect(order[0]).toBe(1);
  });

  test("calls onPartialReady after threshold crossed", async () => {
    let partialCalled = false;
    let completedCount = 0;
    let remainingCount = 0;

    const promises = [
      Promise.resolve("a"),
      Promise.resolve("b"),
      Bun.sleep(100).then(() => "c"),
      Bun.sleep(100).then(() => "d"),
    ];

    await collectIncrementally(promises, {
      onResult: async () => {},
      onPartialReady: async (completed, remaining) => {
        partialCalled = true;
        completedCount = completed.length;
        remainingCount = remaining;
      },
      partialThreshold: 0.5,
    });

    expect(partialCalled).toBe(true);
    expect(completedCount).toBeGreaterThanOrEqual(2);
    expect(remainingCount).toBeGreaterThanOrEqual(0);
  });

  test("handles rejected promises", async () => {
    const promises = [
      Promise.resolve("ok"),
      Promise.reject(new Error("fail")),
      Promise.resolve("also ok"),
    ];

    const results = await collectIncrementally(promises, {
      onResult: async () => {},
    });

    expect(results.length).toBe(3);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(1);
  });

  test("works with empty array", async () => {
    const results = await collectIncrementally([], {
      onResult: async () => {},
    });
    expect(results.length).toBe(0);
  });

  test("does not fire onPartialReady when all complete simultaneously", async () => {
    let partialCalled = false;
    const promises = [Promise.resolve("a")];

    await collectIncrementally(promises, {
      onResult: async () => {},
      onPartialReady: async () => {
        partialCalled = true;
      },
      partialThreshold: 0.5,
    });

    // Single promise: threshold met but completed === total, so partial shouldn't fire
    expect(partialCalled).toBe(false);
  });

  test("works with threshold=1 (never fires partial early)", async () => {
    let partialCalled = false;
    const promises = [
      Promise.resolve("a"),
      Bun.sleep(50).then(() => "b"),
    ];

    await collectIncrementally(promises, {
      onResult: async () => {},
      onPartialReady: async () => {
        partialCalled = true;
      },
      partialThreshold: 1.0,
    });

    // threshold=1 means all must complete, but then completed===total, so partial won't fire
    expect(partialCalled).toBe(false);
  });
});
