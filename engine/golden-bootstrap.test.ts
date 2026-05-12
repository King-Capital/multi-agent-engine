import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { generateGoldenTraces } from "./golden-bootstrap";
import { getGoldenTraces } from "./replay";

const TEST_DIR = join(import.meta.dir, "..", ".test-golden-bootstrap-" + process.pid);

function writeTrace(sessionId: string, status = "completed"): void {
  const events = [
    { ts: "2026-05-11T00:00:00.000Z", type: "session.start", id: `${sessionId}-start`, session_id: sessionId, goal: "Test goal", chain: "build-verify" },
    { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: `${sessionId}-step-start`, session_id: sessionId, step: 1 },
    { ts: "2026-05-11T00:00:02.000Z", type: "llm.call", id: `${sessionId}-llm`, session_id: sessionId, model: "sonnet" },
    { ts: "2026-05-11T00:00:03.000Z", type: "chain.step.end", id: `${sessionId}-step-end`, session_id: sessionId, step: 1, status: "completed" },
    { ts: "2026-05-11T00:00:04.000Z", type: "session.end", id: `${sessionId}-end`, session_id: sessionId, status, total_cost: 0.01 },
  ];
  writeFileSync(join(TEST_DIR, `${sessionId}.jsonl`), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

describe("golden bootstrap", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("adds passing generated traces to the golden registry", async () => {
    writeTrace("g-pass");

    const result = await generateGoldenTraces({
      traceDirOverride: TEST_DIR,
      goals: [{ chain: "build-verify", goal: "small task" }],
      runner: async () => ({ sessionId: "g-pass", output: "Session g-pass completed" }),
    });

    expect(result.added).toBe(1);
    expect(result.failed).toBe(0);
    expect(getGoldenTraces(TEST_DIR)[0]!.sessionId).toBe("g-pass");
  });

  test("logs failed generated traces without adding them", async () => {
    writeTrace("g-fail", "error");

    const result = await generateGoldenTraces({
      traceDirOverride: TEST_DIR,
      goals: [{ chain: "review-only", goal: "small review" }],
      runner: async () => ({ sessionId: "g-fail", output: "Session g-fail failed" }),
    });

    expect(result.added).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.runs[0]!.reason).toContain("score did not pass");
    expect(getGoldenTraces(TEST_DIR)).toEqual([]);
  });
});
