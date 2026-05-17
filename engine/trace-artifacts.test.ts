import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let traceDir = "";

beforeEach(() => {
  traceDir = mkdtempSync(join(tmpdir(), "mae-trace-artifacts-"));
  process.env.MAE_TRACE_DIR = traceDir;
});

afterEach(() => {
  rmSync(traceDir, { recursive: true, force: true });
  delete process.env.MAE_TRACE_DIR;
});

describe("writeAgentOutputArtifact", () => {
  test("redacts secrets before writing output artifacts", async () => {
    const { writeAgentOutputArtifact } = await import("./trace-artifacts");
    const artifact = writeAgentOutputArtifact("sess-1", "agent-1", "token sk-ant-api03-" + "a".repeat(80));

    expect(artifact?.output_artifact).toBeDefined();
    const path = join(traceDir, artifact!.output_artifact);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("[REDACTED_SECRET]");
    expect(content).not.toContain("sk-ant-api03-");
  });
});
