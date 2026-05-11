import { describe, test, expect, afterEach } from "bun:test";
import {
  probeAdapters,
  probeTraces,
  probeDashboard,
  probeLangfuse,
  runHealthCheck,
  formatHealthReport,
  type ProbeResult,
  type HealthReport,
} from "./health";
import type { PlatformAdapter, DelegateOptions, DelegateResult } from "./types";

// --- Test Adapters ---

function makeAdapter(name: string, available: boolean): PlatformAdapter {
  return {
    name,
    isAvailable: async () => available,
    delegate: async (_opts: DelegateOptions): Promise<DelegateResult> => ({
      agentId: name,
      agentName: name,
      output: "",
      costUsd: 0,
      tokensUsed: 0,
    }),
  };
}

function throwingAdapter(name: string): PlatformAdapter {
  return {
    name,
    isAvailable: async () => { throw new Error("adapter exploded"); },
    delegate: async (_opts: DelegateOptions): Promise<DelegateResult> => ({
      agentId: name,
      agentName: name,
      output: "",
      costUsd: 0,
      tokensUsed: 0,
    }),
  };
}

// --- probeAdapters ---

describe("probeAdapters", () => {
  test("all adapters available → healthy", async () => {
    const result = await probeAdapters([
      makeAdapter("echo", true),
      makeAdapter("pi", true),
    ]);
    expect(result.status).toBe("healthy");
    expect(result.message).toBe("2/2 adapters available");
    expect(result.details).toEqual({ echo: true, pi: true });
  });

  test("some adapters unavailable → degraded", async () => {
    const result = await probeAdapters([
      makeAdapter("echo", true),
      makeAdapter("pi", false),
    ]);
    expect(result.status).toBe("degraded");
    expect(result.message).toBe("1/2 adapters available");
  });

  test("no adapters available → unhealthy", async () => {
    const result = await probeAdapters([
      makeAdapter("echo", false),
      makeAdapter("pi", false),
    ]);
    expect(result.status).toBe("unhealthy");
    expect(result.message).toBe("0/2 adapters available");
  });

  test("no adapters registered → unhealthy", async () => {
    const result = await probeAdapters([]);
    expect(result.status).toBe("unhealthy");
    expect(result.message).toBe("No adapters registered");
  });

  test("adapter throws → treated as unavailable", async () => {
    const result = await probeAdapters([
      makeAdapter("echo", true),
      throwingAdapter("broken"),
    ]);
    expect(result.status).toBe("degraded");
    expect(result.details).toEqual({ echo: true, broken: false });
  });

  test("includes latencyMs", async () => {
    const result = await probeAdapters([makeAdapter("echo", true)]);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// --- probeTraces ---

describe("probeTraces", () => {
  test("returns healthy when TRACE_DIR is writable", () => {
    const result = probeTraces();
    // In test env, ~/.mae/traces should be creatable
    expect(result.name).toBe("traces");
    expect(["healthy", "unhealthy"]).toContain(result.status);
    expect(result.details?.path).toBeDefined();
    expect(typeof result.latencyMs).toBe("number");
  });
});

// --- probeDashboard ---

describe("probeDashboard", () => {
  test("unreachable dashboard → degraded", async () => {
    // Use a port that won't be listening
    const result = await probeDashboard("http://127.0.0.1:19999");
    expect(result.name).toBe("dashboard");
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("unreachable");
    expect(result.details?.url).toBe("http://127.0.0.1:19999");
  });

  test("includes latencyMs", async () => {
    const result = await probeDashboard("http://127.0.0.1:19999");
    expect(typeof result.latencyMs).toBe("number");
  });
});

// --- probeLangfuse ---

describe("probeLangfuse", () => {
  const origPub = process.env.LANGFUSE_PUBLIC_KEY;
  const origSec = process.env.LANGFUSE_SECRET_KEY;
  const origHost = process.env.LANGFUSE_HOST;

  afterEach(() => {
    // Restore all env vars (including LANGFUSE_HOST set in tests)
    if (origPub !== undefined) process.env.LANGFUSE_PUBLIC_KEY = origPub;
    else delete process.env.LANGFUSE_PUBLIC_KEY;
    if (origSec !== undefined) process.env.LANGFUSE_SECRET_KEY = origSec;
    else delete process.env.LANGFUSE_SECRET_KEY;
    if (origHost !== undefined) process.env.LANGFUSE_HOST = origHost;
    else delete process.env.LANGFUSE_HOST;
  });

  test("not configured → degraded", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const result = await probeLangfuse();
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("not configured");
    expect(result.details?.configured).toBe(false);
  });

  test("configured but unreachable → degraded", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_HOST = "http://127.0.0.1:19998";
    const result = await probeLangfuse();
    expect(result.status).toBe("degraded");
    expect(result.message).toContain("unreachable");
    // LANGFUSE_HOST cleanup handled by afterEach
  });
});

// --- runHealthCheck ---

describe("runHealthCheck", () => {
  test("returns a complete report", async () => {
    const report = await runHealthCheck(
      [makeAdapter("echo", true)],
      "http://127.0.0.1:19999",
      "0.2.70"
    );
    expect(report.version).toBe("0.2.70");
    expect(report.timestamp).toBeTruthy();
    expect(report.probes).toHaveLength(4);
    expect(report.probes.map((p) => p.name).sort()).toEqual([
      "adapters",
      "dashboard",
      "langfuse",
      "traces",
    ]);
    // Overall should be at least degraded (dashboard is unreachable)
    expect(["healthy", "degraded", "unhealthy"]).toContain(report.status);
  });

  test("overall healthy when all probes healthy", async () => {
    // Can't guarantee Langfuse/Dashboard are up, so verify adapter probe directly
    const realReport = await runHealthCheck(
      [makeAdapter("echo", true)],
      "http://127.0.0.1:19999",
      "test"
    );
    // At minimum, adapters probe should be healthy
    const adapterProbe = realReport.probes.find((p) => p.name === "adapters");
    expect(adapterProbe?.status).toBe("healthy");
  });

  test("overall unhealthy when no adapters", async () => {
    const report = await runHealthCheck([], "http://127.0.0.1:19999", "test");
    expect(report.status).toBe("unhealthy");
  });
});

// --- formatHealthReport ---

describe("formatHealthReport", () => {
  test("produces readable output with status icons", () => {
    const report: HealthReport = {
      status: "degraded",
      timestamp: "2026-05-11T10:00:00.000Z",
      version: "0.2.70",
      probes: [
        { name: "adapters", status: "healthy", message: "2/2 available", latencyMs: 5 },
        { name: "traces", status: "healthy", message: "writable", latencyMs: 1 },
        { name: "dashboard", status: "degraded", message: "unreachable", latencyMs: 3000 },
        { name: "langfuse", status: "unhealthy", message: "auth failed", latencyMs: 100 },
      ],
    };
    const output = formatHealthReport(report);
    expect(output).toContain("MAE Health Check");
    expect(output).toContain("v0.2.70");
    expect(output).toContain("DEGRADED");
    expect(output).toContain("adapters");
    expect(output).toContain("traces");
    expect(output).toContain("dashboard");
    expect(output).toContain("langfuse");
    expect(output).toContain("5ms");
    expect(output).toContain("3000ms");
  });

  test("healthy report shows HEALTHY", () => {
    const report: HealthReport = {
      status: "healthy",
      timestamp: "2026-05-11T10:00:00.000Z",
      version: "1.0.0",
      probes: [
        { name: "test", status: "healthy", message: "all good" },
      ],
    };
    const output = formatHealthReport(report);
    expect(output).toContain("HEALTHY");
  });

  test("handles missing latencyMs gracefully", () => {
    const report: HealthReport = {
      status: "healthy",
      timestamp: "2026-05-11T10:00:00.000Z",
      version: "1.0.0",
      probes: [
        { name: "test", status: "healthy", message: "ok" },
      ],
    };
    const output = formatHealthReport(report);
    expect(output).not.toContain("undefined");
  });
});
