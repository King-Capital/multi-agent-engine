import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadTrace,
  extractFingerprint,
  compareFingerprints,
  scoreSession,
  addGoldenTrace,
  getGoldenTraces,
} from "./replay";
import type { SessionTrace, BehavioralFingerprint } from "./replay";

const TEST_DIR = join(import.meta.dir, "..", ".test-replay-" + process.pid);

function writeTrace(sessionId: string, events: Record<string, unknown>[]): void {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(TEST_DIR, `${sessionId}.jsonl`), content);
}

/** Build a minimal valid session trace (session.start + session.end + optional extras). */
function buildTraceEvents(
  sessionId: string,
  overrides?: {
    goal?: string;
    chain?: string;
    status?: string;
    totalCost?: number;
    extraEvents?: Record<string, unknown>[];
  },
): Record<string, unknown>[] {
  const o = overrides ?? {};
  const events: Record<string, unknown>[] = [
    {
      ts: "2026-05-11T00:00:00.000Z",
      type: "session.start",
      id: "evt-start",
      session_id: sessionId,
      goal: o.goal ?? "Test goal",
      chain: o.chain ?? "plan-build-review",
      component: "orchestrator",
      msg: "Session started",
      level: "INFO",
    },
    ...(o.extraEvents ?? []),
    {
      ts: "2026-05-11T00:01:00.000Z",
      type: "session.end",
      id: "evt-end",
      session_id: sessionId,
      status: o.status ?? "completed",
      total_cost: o.totalCost ?? 0.05,
      component: "orchestrator",
      msg: "Session ended",
      level: "INFO",
    },
  ];
  return events;
}

describe("replay", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  // ---------- loadTrace ----------

  describe("loadTrace", () => {
    test("reads a valid JSONL file and returns correct SessionTrace", () => {
      const events = buildTraceEvents("s1", {
        goal: "Build auth middleware",
        chain: "build-verify",
        status: "completed",
        totalCost: 1.23,
      });
      writeTrace("s1", events);

      const trace = loadTrace("s1", TEST_DIR);
      expect(trace.sessionId).toBe("s1");
      expect(trace.goal).toBe("Build auth middleware");
      expect(trace.chain).toBe("build-verify");
      expect(trace.status).toBe("completed");
      expect(trace.totalCost).toBe(1.23);
      expect(trace.events).toHaveLength(2);
      expect(trace.duration_ms).toBeGreaterThanOrEqual(0);
    });

    test("handles missing file gracefully with an error", () => {
      expect(() => loadTrace("nonexistent", TEST_DIR)).toThrow(/Trace not found/);
    });

    test("handles empty file gracefully", () => {
      writeFileSync(join(TEST_DIR, "empty.jsonl"), "");
      expect(() => loadTrace("empty", TEST_DIR)).toThrow(/Empty trace|No valid events/);
    });

    test("extracts goal from task_preview when goal is absent", () => {
      const events = [
        {
          ts: "2026-05-11T00:00:00.000Z",
          type: "session.start",
          id: "e1",
          session_id: "s-tp",
          task_preview: "Fix the login bug",
          chain: "build-verify",
          component: "orchestrator",
          msg: "Session started",
          level: "INFO",
        },
        {
          ts: "2026-05-11T00:01:00.000Z",
          type: "session.end",
          id: "e2",
          session_id: "s-tp",
          status: "completed",
          component: "orchestrator",
          msg: "Session ended",
          level: "INFO",
        },
      ];
      writeTrace("s-tp", events);

      const trace = loadTrace("s-tp", TEST_DIR);
      expect(trace.goal).toBe("Fix the login bug");
    });
  });

  // ---------- extractFingerprint ----------

  describe("extractFingerprint", () => {
    test("produces correct tool/agent/team/step sequences", () => {
      const events = buildTraceEvents("s-fp", {
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-fp", step: 1, name: "build" },
          { ts: "2026-05-11T00:00:02.000Z", type: "agent.start", id: "a1", session_id: "s-fp", team: "Engineering" },
          { ts: "2026-05-11T00:00:03.000Z", type: "tool.call", id: "t1", session_id: "s-fp", tool: "read" },
          { ts: "2026-05-11T00:00:04.000Z", type: "tool.call", id: "t2", session_id: "s-fp", tool: "write" },
          { ts: "2026-05-11T00:00:05.000Z", type: "tool.call", id: "t3", session_id: "s-fp", tool: "bash" },
          { ts: "2026-05-11T00:00:06.000Z", type: "agent.start", id: "a2", session_id: "s-fp", team: "Validation" },
          { ts: "2026-05-11T00:00:07.000Z", type: "chain.step.end", id: "cse1", session_id: "s-fp", step: 1, status: "completed" },
          { ts: "2026-05-11T00:00:08.000Z", type: "chain.step.start", id: "cs2", session_id: "s-fp", step: 2, name: "verify" },
          { ts: "2026-05-11T00:00:09.000Z", type: "chain.step.end", id: "cse2", session_id: "s-fp", step: 2, status: "completed" },
        ],
      });
      writeTrace("s-fp", events);

      const trace = loadTrace("s-fp", TEST_DIR);
      const fp = extractFingerprint(trace);

      expect(fp.toolSequence).toEqual(["read", "write", "bash"]);
      expect(fp.agentCount).toBe(2);
      expect(fp.teamSequence).toEqual(["Engineering", "Validation"]);
      expect(fp.stepCount).toBe(2);
      expect(fp.errorCount).toBe(0);
      expect(fp.statusTransitions).toContain("step:completed");
    });

    test("counts ERROR/CRITICAL log events as errors", () => {
      const events = buildTraceEvents("s-err", {
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "log", id: "l1", session_id: "s-err", level: "ERROR", msg: "Something failed", component: "test" },
          { ts: "2026-05-11T00:00:02.000Z", type: "log", id: "l2", session_id: "s-err", level: "CRITICAL", msg: "Very bad", component: "test" },
          { ts: "2026-05-11T00:00:03.000Z", type: "agent.error", id: "ae1", session_id: "s-err", error: "timeout" },
        ],
      });
      writeTrace("s-err", events);

      const trace = loadTrace("s-err", TEST_DIR);
      const fp = extractFingerprint(trace);

      // 1 agent.error + 2 ERROR/CRITICAL logs = 3
      expect(fp.errorCount).toBe(3);
    });
  });

  // ---------- compareFingerprints ----------

  describe("compareFingerprints", () => {
    test("returns 1.0 for identical fingerprints", () => {
      const fp: BehavioralFingerprint = {
        toolSequence: ["read", "write", "bash"],
        agentCount: 3,
        teamSequence: ["Engineering", "Validation"],
        stepCount: 2,
        errorCount: 0,
        statusTransitions: ["step:completed", "step:completed", "completed"],
      };

      const result = compareFingerprints(fp, fp);
      expect(result.similarity).toBe(1.0);
      expect(result.diffs).toHaveLength(0);
    });

    test("returns <1.0 for different fingerprints and lists diffs", () => {
      const fpA: BehavioralFingerprint = {
        toolSequence: ["read", "write", "bash"],
        agentCount: 3,
        teamSequence: ["Engineering", "Validation"],
        stepCount: 2,
        errorCount: 0,
        statusTransitions: ["completed"],
      };

      const fpB: BehavioralFingerprint = {
        toolSequence: ["read", "edit"],
        agentCount: 5,
        teamSequence: ["Engineering", "QA"],
        stepCount: 3,
        errorCount: 2,
        statusTransitions: ["error"],
      };

      const result = compareFingerprints(fpA, fpB);
      expect(result.similarity).toBeLessThan(1.0);
      expect(result.diffs.length).toBeGreaterThan(0);
      expect(result.diffs.some((d) => d.includes("agentCount"))).toBe(true);
      expect(result.diffs.some((d) => d.includes("stepCount"))).toBe(true);
      expect(result.diffs.some((d) => d.includes("errorCount"))).toBe(true);
    });

    test("handles empty fingerprints (both empty)", () => {
      const fp: BehavioralFingerprint = {
        toolSequence: [],
        agentCount: 0,
        teamSequence: [],
        stepCount: 0,
        errorCount: 0,
        statusTransitions: [],
      };

      const result = compareFingerprints(fp, fp);
      expect(result.similarity).toBe(1.0);
      expect(result.diffs).toHaveLength(0);
    });
  });

  // ---------- scoreSession ----------

  describe("scoreSession", () => {
    test('returns "pass" for a completed session with no errors', () => {
      const events = buildTraceEvents("s-pass", {
        status: "completed",
        totalCost: 0.5,
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-pass", step: 1 },
          { ts: "2026-05-11T00:00:02.000Z", type: "chain.step.end", id: "cse1", session_id: "s-pass", step: 1, status: "completed" },
        ],
      });
      writeTrace("s-pass", events);

      const trace = loadTrace("s-pass", TEST_DIR);
      const score = scoreSession(trace);

      expect(score.overall).toBe("pass");
      expect(score.checks.every((c) => c.pass)).toBe(true);
      expect(score.fingerprint).toBeDefined();
    });

    test('returns "fail" for a session with status "error"', () => {
      const events = buildTraceEvents("s-fail", {
        status: "error",
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "agent.error", id: "ae1", session_id: "s-fail", error: "timeout" },
        ],
      });
      writeTrace("s-fail", events);

      const trace = loadTrace("s-fail", TEST_DIR);
      const score = scoreSession(trace);

      expect(score.overall).toBe("fail");
      expect(score.checks.find((c) => c.name === "session_completed")?.pass).toBe(false);
    });

    test('returns "partial" for completed session with agent errors', () => {
      const events = buildTraceEvents("s-partial", {
        status: "completed",
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-partial", step: 1 },
          { ts: "2026-05-11T00:00:02.000Z", type: "agent.error", id: "ae1", session_id: "s-partial", error: "type check failed" },
          { ts: "2026-05-11T00:00:03.000Z", type: "chain.step.end", id: "cse1", session_id: "s-partial", step: 1, status: "completed" },
        ],
      });
      writeTrace("s-partial", events);

      const trace = loadTrace("s-partial", TEST_DIR);
      const score = scoreSession(trace);

      expect(score.overall).toBe("partial");
    });

    test("flags excessive cost", () => {
      const events = buildTraceEvents("s-expensive", {
        status: "completed",
        totalCost: 10.0,
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-expensive", step: 1 },
          { ts: "2026-05-11T00:00:02.000Z", type: "chain.step.end", id: "cse1", session_id: "s-expensive", step: 1 },
        ],
      });
      writeTrace("s-expensive", events);

      const trace = loadTrace("s-expensive", TEST_DIR);
      const score = scoreSession(trace);

      const costCheck = score.checks.find((c) => c.name === "cost_reasonable");
      expect(costCheck?.pass).toBe(false);
    });
  });

  // ---------- Golden Traces ----------

  describe("golden traces", () => {
    test("addGoldenTrace writes to registry, getGoldenTraces reads it back", () => {
      // Create a trace for the golden entry to reference
      const events = buildTraceEvents("golden-1", { goal: "Build auth middleware" });
      writeTrace("golden-1", events);

      addGoldenTrace("golden-1", "pass", "Clean run", TEST_DIR);

      const entries = getGoldenTraces(TEST_DIR);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.sessionId).toBe("golden-1");
      expect(entries[0]!.goal).toBe("Build auth middleware");
      expect(entries[0]!.verdict).toBe("pass");
      expect(entries[0]!.notes).toBe("Clean run");
      expect(entries[0]!.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("addGoldenTrace replaces existing entry for same session", () => {
      const events = buildTraceEvents("golden-replace", { goal: "Fix bug" });
      writeTrace("golden-replace", events);

      addGoldenTrace("golden-replace", "fail", "First attempt", TEST_DIR);
      addGoldenTrace("golden-replace", "pass", "Fixed now", TEST_DIR);

      const entries = getGoldenTraces(TEST_DIR);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.verdict).toBe("pass");
      expect(entries[0]!.notes).toBe("Fixed now");
    });

    test("getGoldenTraces returns empty array when no registry exists", () => {
      const entries = getGoldenTraces(TEST_DIR);
      expect(entries).toEqual([]);
    });

    test("multiple golden traces accumulate", () => {
      const events1 = buildTraceEvents("g1", { goal: "Task 1" });
      const events2 = buildTraceEvents("g2", { goal: "Task 2" });
      writeTrace("g1", events1);
      writeTrace("g2", events2);

      addGoldenTrace("g1", "pass", undefined, TEST_DIR);
      addGoldenTrace("g2", "fail", "Agent skipped tests", TEST_DIR);

      const entries = getGoldenTraces(TEST_DIR);
      expect(entries).toHaveLength(2);
    });
  });
});
