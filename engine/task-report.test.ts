import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let traceDir = "";

beforeEach(() => {
  traceDir = mkdtempSync(join(tmpdir(), "mae-task-report-"));
  process.env.MAE_TRACE_DIR = traceDir;
});

afterEach(() => {
  rmSync(traceDir, { recursive: true, force: true });
  delete process.env.MAE_TRACE_DIR;
});

describe("writeTaskReport", () => {
  test("writes RALPH-style human-readable task reports", async () => {
    const { writeTaskReport } = await import("./task-report");
    const artifact = writeTaskReport("sess-1", "agent-1", {
      persona: { name: "Code Reviewer", model: "opus", expertise: "", tools: ["read"], skills: [], domain: { read: ["**/*"], write: [], update: [] } },
      systemPrompt: "review",
      userPrompt: "task",
      model: "opus",
      thinking: "medium",
      teamName: "Validation",
      teamColor: "#ffffff",
      tools: ["read"],
      domain: { read: ["**/*"], write: [], update: [] },
      workingDir: "/tmp",
      sessionDir: "data/sessions/sess-1",
    }, {
      agentId: "agent-1",
      agentName: "Code Reviewer",
      output: "Reviewed implementation.\n## Modified Files\n- engine/foo.ts\n- engine/bar.ts",
      grade: "VERIFIED",
      findings: [],
      costUsd: 0.01,
      tokensUsed: 123,
    });

    expect(artifact?.task_report).toBe("sess-1/RALPH/agent-1.md");
    const report = readFileSync(join(traceDir, "sess-1", "RALPH", "agent-1.md"), "utf8");
    expect(report).toContain("# Task agent-1 — Code Reviewer");
    expect(report).toContain("## Result");
    expect(report).toContain("- engine/foo.ts");
    expect(report).toContain("✅ Complete");
  });

  test("redacts secrets from task reports", async () => {
    const { writeTaskReport } = await import("./task-report");
    writeTaskReport("sess-2", "agent-2", {
      persona: { name: "Security Reviewer", model: "opus", expertise: "", tools: ["read"], skills: [], domain: { read: ["**/*"], write: [], update: [] } },
      systemPrompt: "review",
      userPrompt: "task",
      model: "opus",
      thinking: "medium",
      teamName: "Validation",
      teamColor: "#ffffff",
      tools: ["read"],
      domain: { read: ["**/*"], write: [], update: [] },
      workingDir: "/tmp",
      sessionDir: "data/sessions/sess-2",
    }, {
      agentId: "agent-2",
      agentName: "Security Reviewer",
      output: "Found token sk-ant-api03-" + "a".repeat(80),
      grade: "VERIFIED",
      findings: [],
      costUsd: 0,
      tokensUsed: 0,
    });

    const report = readFileSync(join(traceDir, "sess-2", "RALPH", "agent-2.md"), "utf8");
    expect(report).toContain("[REDACTED_SECRET]");
    expect(report).not.toContain("sk-ant-api03-");
  });
});
