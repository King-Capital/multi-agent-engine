import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { logPerformance, loadPerformance, buildScorecard } from "./perf-log";
import type { PerfRecord } from "./perf-log";
import { join, dirname } from "path";
import { unlinkSync, existsSync } from "fs";

// Use the same path logic as perf-log.ts
const dataPath = join(dirname(import.meta.dir), "data", "model-performance.jsonl");

function makePerfRecord(overrides?: Partial<PerfRecord>): PerfRecord {
  return {
    model: "claude-sonnet-4-6",
    role: "worker",
    grade: "PASS",
    cost_usd: 0.25,
    latency_ms: 30000,
    findings_count: 3,
    agent_name: "test-agent",
    session_id: "test-session-123",
    timestamp: "2026-05-09T12:00:00.000Z",
    ...overrides,
  };
}

// Back up and restore the real data file around tests
let originalContent: string | null = null;

beforeEach(async () => {
  const file = Bun.file(dataPath);
  if (await file.exists()) {
    originalContent = await file.text();
  } else {
    originalContent = null;
  }
  // Clear the file for tests
  if (existsSync(dataPath)) unlinkSync(dataPath);
});

afterEach(async () => {
  // Restore original content
  if (originalContent !== null) {
    await Bun.write(dataPath, originalContent);
  } else if (existsSync(dataPath)) {
    unlinkSync(dataPath);
  }
});

describe("logPerformance", () => {
  test("writes valid JSONL", async () => {
    const record = makePerfRecord();
    await logPerformance(record);

    const content = await Bun.file(dataPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.role).toBe("worker");
    expect(parsed.grade).toBe("PASS");
    expect(parsed.cost_usd).toBe(0.25);
  });

  test("appends multiple records", async () => {
    await logPerformance(makePerfRecord({ agent_name: "agent-1" }));
    await logPerformance(makePerfRecord({ agent_name: "agent-2" }));

    const content = await Bun.file(dataPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    const second = JSON.parse(lines[1]!);
    expect(first.agent_name).toBe("agent-1");
    expect(second.agent_name).toBe("agent-2");
  });
});

describe("loadPerformance", () => {
  test("reads back written records", async () => {
    const record = makePerfRecord();
    await logPerformance(record);

    const records = await loadPerformance();
    expect(records).toHaveLength(1);
    expect(records[0]!.model).toBe("claude-sonnet-4-6");
    expect(records[0]!.cost_usd).toBe(0.25);
  });

  test("returns empty array for missing file", async () => {
    const records = await loadPerformance();
    expect(records).toHaveLength(0);
  });

  test("handles empty file", async () => {
    await Bun.write(dataPath, "");
    const records = await loadPerformance();
    expect(records).toHaveLength(0);
  });
});

describe("buildScorecard", () => {
  test("aggregates by model+role", () => {
    const records: PerfRecord[] = [
      makePerfRecord({ model: "opus", role: "lead", grade: "PASS", cost_usd: 0.5, latency_ms: 40000, findings_count: 4 }),
      makePerfRecord({ model: "opus", role: "lead", grade: "VERIFIED", cost_usd: 0.9, latency_ms: 50000, findings_count: 6 }),
      makePerfRecord({ model: "sonnet", role: "worker", grade: "PASS", cost_usd: 0.3, latency_ms: 30000, findings_count: 2 }),
      makePerfRecord({ model: "sonnet", role: "worker", grade: "FAILED", cost_usd: 0.2, latency_ms: 25000, findings_count: 1 }),
    ];

    const scores = buildScorecard(records);
    expect(scores).toHaveLength(2);

    const opusLead = scores.find((s) => s.model === "opus" && s.role === "lead");
    expect(opusLead).toBeDefined();
    expect(opusLead!.runs).toBe(2);
    expect(opusLead!.avg_cost_usd).toBe(0.7);
    expect(opusLead!.avg_latency_ms).toBe(45000);
    expect(opusLead!.avg_findings).toBe(5);
    expect(opusLead!.pass_rate).toBe(100); // PASS + VERIFIED both count

    const sonnetWorker = scores.find((s) => s.model === "sonnet" && s.role === "worker");
    expect(sonnetWorker).toBeDefined();
    expect(sonnetWorker!.runs).toBe(2);
    expect(sonnetWorker!.pass_rate).toBe(50); // 1 PASS, 1 FAILED
  });

  test("returns empty array for no records", () => {
    expect(buildScorecard([])).toHaveLength(0);
    expect(buildScorecard(undefined)).toHaveLength(0);
  });

  test("counts PERFECT as passing", () => {
    const records: PerfRecord[] = [
      makePerfRecord({ grade: "PERFECT" }),
      makePerfRecord({ grade: "FEEDBACK" }),
    ];
    const scores = buildScorecard(records);
    expect(scores[0]!.pass_rate).toBe(50);
  });

  test("sorts by pass rate descending, then cost ascending", () => {
    const records: PerfRecord[] = [
      makePerfRecord({ model: "cheap", role: "worker", grade: "FAILED", cost_usd: 0.1 }),
      makePerfRecord({ model: "expensive", role: "worker", grade: "PASS", cost_usd: 1.0 }),
      makePerfRecord({ model: "mid", role: "worker", grade: "PASS", cost_usd: 0.5 }),
    ];
    const scores = buildScorecard(records);
    // expensive and mid both 100% pass rate, mid cheaper so first
    expect(scores[0]!.model).toBe("mid");
    expect(scores[1]!.model).toBe("expensive");
    expect(scores[2]!.model).toBe("cheap");
  });
});
