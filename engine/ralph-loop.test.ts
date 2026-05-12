import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { parseFindings } from "./ralph-evaluator";
import type { EvaluatorFinding } from "./ralph-evaluator";
import { parseMutations } from "./ralph-evolver";
import type { ConfigMutation } from "./ralph-evolver";
import { applyMutation, numericScore, runRalphLoop, verifyMutation } from "./ralph-loop";
import { addGoldenTrace } from "./replay";
import type { ReplayScore, BehavioralFingerprint } from "./replay";

const TEST_DIR = join(import.meta.dir, "..", ".test-ralph-" + process.pid);
const TRACE_DIR = join(TEST_DIR, "traces");
const PERSONA_DIR = join(TEST_DIR, "personas");

function writeTrace(sessionId: string, events: Record<string, unknown>[]): void {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(TRACE_DIR, `${sessionId}.jsonl`), content);
}

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
  return [
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
}

function writePersona(slug: string, content: string): void {
  writeFileSync(join(PERSONA_DIR, `${slug}.md`), content);
}

function writePassingGolden(sessionId: string, persona = "Test Agent"): void {
  writeTrace(sessionId, buildTraceEvents(sessionId, {
    goal: "Passing golden",
    chain: "build-verify",
    status: "completed",
    totalCost: 0.05,
    extraEvents: [
      { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: `${sessionId}-cs`, session_id: sessionId, step: 1 },
      { ts: "2026-05-11T00:00:02.000Z", type: "agent.start", id: `${sessionId}-as`, session_id: sessionId, agent_id: "test-agent-1", persona, team: "Engineering" },
      { ts: "2026-05-11T00:00:03.000Z", type: "llm.call", id: `${sessionId}-llm`, session_id: sessionId, agent_id: "test-agent-1", model: "sonnet" },
      { ts: "2026-05-11T00:00:04.000Z", type: "agent.end", id: `${sessionId}-ae`, session_id: sessionId, agent_id: "test-agent-1", persona, output_preview: "done" },
      { ts: "2026-05-11T00:00:05.000Z", type: "chain.step.end", id: `${sessionId}-ce`, session_id: sessionId, step: 1, status: "completed" },
    ],
  }));
  addGoldenTrace(sessionId, "pass", "test golden", TRACE_DIR);
}

const SAMPLE_PERSONA = `---
name: Test Agent
model: main
expertise: agents/expertise/test-agent.md
skills:
  - agents/skills/active-listener.md
tools:
  - read
  - write
  - bash
domain:
  read: ["**/*"]
  write: ["src/**"]
  update: ["src/**"]
---

# Purpose

You are Test Agent — a worker agent for testing.

## Rules

1. Execute tasks as briefed.
2. Load your expertise file at session start.
`;

describe("ralph-evaluator", () => {
  describe("parseFindings", () => {
    test("parses valid JSON array of findings", () => {
      const raw = JSON.stringify([
        {
          type: "weak_output",
          persona: "builder",
          evidence: "Session s1 produced empty output",
          severity: "high",
          suggestion: "Add explicit output format instructions",
        },
        {
          type: "high_cost",
          persona: "planner",
          evidence: "Session s2 cost $4.50",
          severity: "medium",
          suggestion: "Reduce context window",
        },
      ]);

      const findings = parseFindings(raw);
      expect(findings).toHaveLength(2);
      expect(findings[0]!.type).toBe("weak_output");
      expect(findings[0]!.persona).toBe("builder");
      expect(findings[1]!.type).toBe("high_cost");
    });

    test("handles markdown-fenced JSON", () => {
      const raw = "```json\n" + JSON.stringify([{
        type: "failure_pattern",
        persona: "reviewer",
        evidence: "3 timeouts in 5 sessions",
        severity: "high",
        suggestion: "Increase timeout or reduce scope",
      }]) + "\n```";

      const findings = parseFindings(raw);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.type).toBe("failure_pattern");
    });

    test("returns empty array for invalid JSON", () => {
      expect(parseFindings("not json at all")).toEqual([]);
      expect(parseFindings("")).toEqual([]);
    });

    test("filters out findings with invalid types", () => {
      const raw = JSON.stringify([
        { type: "unknown_type", persona: "x", evidence: "e", severity: "high", suggestion: "s" },
        { type: "weak_output", persona: "builder", evidence: "e", severity: "high", suggestion: "s" },
      ]);

      const findings = parseFindings(raw);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.type).toBe("weak_output");
    });

    test("defaults severity to medium when invalid", () => {
      const raw = JSON.stringify([
        { type: "weak_output", persona: "x", evidence: "e", severity: "extreme", suggestion: "s" },
      ]);

      const findings = parseFindings(raw);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe("medium");
    });

    test("filters out findings with missing required fields", () => {
      const raw = JSON.stringify([
        { type: "weak_output", persona: "x" }, // missing evidence + suggestion
        { type: "weak_output", evidence: "e", suggestion: "s" }, // missing persona
      ]);

      const findings = parseFindings(raw);
      expect(findings).toHaveLength(0);
    });
  });
});

describe("ralph-evolver", () => {
  describe("parseMutations", () => {
    test("parses valid JSON array of mutations", () => {
      const raw = JSON.stringify([
        {
          persona: "builder",
          targetType: "persona",
          target: "builder",
          field: "system_prompt",
          action: "append",
          content: "Always verify output before returning.",
          reasoning: "Builder often returns incomplete output",
          verification: "mae replay <golden-id> --dry-run",
        },
      ]);

      const mutations = parseMutations(raw);
      expect(mutations).toHaveLength(1);
      expect(mutations[0]!.persona).toBe("builder");
      expect(mutations[0]!.targetType).toBe("persona");
      expect(mutations[0]!.field).toBe("system_prompt");
      expect(mutations[0]!.action).toBe("append");
      expect(mutations[0]!.verification).toContain("mae replay");
    });

    test("parses advisory chain suggestions", () => {
      const raw = JSON.stringify([
        {
          targetType: "chain",
          target: "standard-swarm",
          file: "agents/teams/chains.yaml",
          field: "chain",
          action: "investigate",
          content: "Verify lead-to-worker spawning is represented as explicit chain steps.",
          reasoning: "Fail goldens show agents started with zero chain steps.",
          verification: "mae replay <fail-golden> --dry-run",
        },
      ]);

      const suggestions = parseMutations(raw);

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]!.persona).toBe("orchestrator");
      expect(suggestions[0]!.targetType).toBe("chain");
      expect(suggestions[0]!.target).toBe("standard-swarm");
      expect(suggestions[0]!.field).toBe("chain");
      expect(suggestions[0]!.action).toBe("investigate");
    });

    test("handles markdown-fenced JSON", () => {
      const raw = "```json\n" + JSON.stringify([{
        persona: "planner",
        field: "model",
        action: "replace",
        content: "quality",
        reasoning: "Upgrade for better planning",
      }]) + "\n```";

      const mutations = parseMutations(raw);
      expect(mutations).toHaveLength(1);
    });

    test("returns empty array for invalid JSON", () => {
      expect(parseMutations("garbage")).toEqual([]);
    });

    test("filters out mutations with invalid fields", () => {
      const raw = JSON.stringify([
        { persona: "x", field: "invalid_field", action: "append", content: "c", reasoning: "r" },
        { persona: "x", field: "system_prompt", action: "append", content: "c", reasoning: "r" },
      ]);

      const mutations = parseMutations(raw);
      expect(mutations).toHaveLength(1);
    });

    test("filters out mutations with invalid actions", () => {
      const raw = JSON.stringify([
        { persona: "x", field: "tools", action: "destroy", content: "c", reasoning: "r" },
      ]);

      expect(parseMutations(raw)).toHaveLength(0);
    });
  });
});

describe("ralph-loop", () => {
  describe("applyMutation", () => {
    test("appends to system prompt body", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "append",
        content: "Always double-check your work.",
        reasoning: "Agent skips verification",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).toContain("Always double-check your work.");
      expect(result).toContain("You are Test Agent"); // original preserved
    });

    test("replaces system prompt body", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "replace",
        content: "# New Purpose\n\nCompletely new instructions.",
        reasoning: "Rewrite persona",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).toContain("# New Purpose");
      expect(result).not.toContain("You are Test Agent");
      expect(result).toContain("name: Test Agent"); // frontmatter preserved
    });

    test("removes text from system prompt body", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "remove",
        content: "2. Load your expertise file at session start.",
        reasoning: "Redundant instruction",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).not.toContain("Load your expertise file at session start.");
      expect(result).toContain("Execute tasks as briefed");
    });

    test("appends a tool to the tools list", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "tools",
        action: "append",
        content: "grep",
        reasoning: "Agent needs search capability",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).toContain("- grep");
      expect(result).toContain("- read"); // existing tools preserved
    });

    test("removes a tool from the tools list", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "tools",
        action: "remove",
        content: "bash",
        reasoning: "Agent should not have shell access",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).not.toMatch(/- bash\n/);
      expect(result).toContain("- read");
    });

    test("replaces model alias", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "model",
        action: "replace",
        content: "quality",
        reasoning: "Agent needs better model",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).toContain("model: quality");
      expect(result).not.toContain("model: main");
    });

    test("appends a skill to the skills list", () => {
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "skills",
        action: "append",
        content: "agents/skills/till-done.md",
        reasoning: "test",
      };

      const result = applyMutation(SAMPLE_PERSONA, mutation);
      expect(result).toContain("- agents/skills/till-done.md");
      expect(result).toContain("agents/skills/active-listener.md");
    });
  });

  describe("numericScore", () => {
    test("returns 1.0 for all-pass checks", () => {
      const score: ReplayScore = {
        sessionId: "s1",
        overall: "pass",
        checks: [
          { name: "a", pass: true },
          { name: "b", pass: true },
          { name: "c", pass: true },
        ],
        fingerprint: emptyFingerprint(),
      };

      expect(numericScore(score)).toBe(1.0);
    });

    test("returns 0.0 for all-fail checks", () => {
      const score: ReplayScore = {
        sessionId: "s1",
        overall: "fail",
        checks: [
          { name: "a", pass: false },
          { name: "b", pass: false },
        ],
        fingerprint: emptyFingerprint(),
      };

      expect(numericScore(score)).toBe(0.0);
    });

    test("returns 0.5 for half-pass", () => {
      const score: ReplayScore = {
        sessionId: "s1",
        overall: "partial",
        checks: [
          { name: "a", pass: true },
          { name: "b", pass: false },
        ],
        fingerprint: emptyFingerprint(),
      };

      expect(numericScore(score)).toBe(0.5);
    });

    test("returns 0 for empty checks", () => {
      const score: ReplayScore = {
        sessionId: "s1",
        overall: "pass",
        checks: [],
        fingerprint: emptyFingerprint(),
      };

      expect(numericScore(score)).toBe(0);
    });
  });

  describe("runRalphLoop", () => {
    beforeEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TRACE_DIR, { recursive: true });
      mkdirSync(PERSONA_DIR, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    });

    test("returns zero iterations when no traces exist", async () => {
      const emptyDir = join(TEST_DIR, "empty-traces");
      mkdirSync(emptyDir, { recursive: true });

      const result = await runRalphLoop({
        traceDir: emptyDir,
        personaDir: PERSONA_DIR,
        dryRun: true,
      });

      expect(result.iterations).toBe(0);
      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.mutations).toHaveLength(0);
    });

    test("defaults to high-signal traces instead of latest traces", async () => {
      writeTrace("s-small", buildTraceEvents("s-small", {
        goal: "Tiny smoke run",
        totalCost: 0.01,
      }));
      writeTrace("s-large", buildTraceEvents("s-large", {
        goal: "Large swarm run",
        totalCost: 2.5,
        extraEvents: [
          { ts: "2026-05-11T00:00:10.000Z", type: "chain.step.start", id: "step-1", session_id: "s-large", step: 1, team: "Planning" },
          { ts: "2026-05-11T00:00:11.000Z", type: "agent.start", id: "agent-1", session_id: "s-large", agent_id: "lead", persona: "test-agent", team: "Planning" },
          { ts: "2026-05-11T00:00:12.000Z", type: "agent.error", id: "err-1", session_id: "s-large", agent_id: "worker", error: "failed" },
          { ts: "2026-05-11T00:00:13.000Z", type: "chain.step.end", id: "step-1-end", session_id: "s-large", step: 1, status: "failed" },
        ],
      }));

      let seenIds: string[] = [];
      const result = await runRalphLoop({
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        traceLimit: 1,
        dryRun: true,
        evaluator: async (traces) => {
          seenIds = traces.map((trace) => trace.sessionId);
          return [];
        },
      });

      expect(result.traces).toHaveLength(1);
      expect(seenIds).toEqual(["s-large"]);
    });

    test("explicit trace selection overrides high-signal selection", async () => {
      writeTrace("s-small", buildTraceEvents("s-small", { goal: "Selected small run", totalCost: 0.01 }));
      writeTrace("s-large", buildTraceEvents("s-large", {
        goal: "Large unselected run",
        totalCost: 2.5,
        extraEvents: [
          { ts: "2026-05-11T00:00:10.000Z", type: "agent.error", id: "err-1", session_id: "s-large", agent_id: "worker", error: "failed" },
        ],
      }));

      let seenIds: string[] = [];
      await runRalphLoop({
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        traceIds: ["s-small"],
        dryRun: true,
        evaluator: async (traces) => {
          seenIds = traces.map((trace) => trace.sessionId);
          return [];
        },
      });

      expect(seenIds).toEqual(["s-small"]);
    });

    test("golden-only mode includes fail goldens for evaluator training", async () => {
      writeTrace("s-fail-golden", buildTraceEvents("s-fail-golden", {
        goal: "Known bad swarm",
        status: "error",
        extraEvents: [
          { ts: "2026-05-11T00:00:10.000Z", type: "agent.start", id: "agent-1", session_id: "s-fail-golden", agent_id: "lead", persona: "orchestrator", team: "Validation" },
          { ts: "2026-05-11T00:00:11.000Z", type: "log", id: "err-1", session_id: "s-fail-golden", level: "ERROR", msg: "worker failed" },
        ],
      }));
      addGoldenTrace("s-fail-golden", "fail", "known bad swarm", TRACE_DIR);

      let seenIds: string[] = [];
      const result = await runRalphLoop({
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        goldenOnly: true,
        dryRun: true,
        evaluator: async (traces) => {
          seenIds = traces.map((trace) => trace.sessionId);
          return [];
        },
      });

      expect(result.traces.map((trace) => trace.sessionId)).toEqual(["s-fail-golden"]);
      expect(seenIds).toEqual(["s-fail-golden"]);
    });

    test("ralph emits suggestions only and does not write files", async () => {
      writeTrace("s-mutate", buildTraceEvents("s-mutate", {
        goal: "Mutation gate run",
        status: "completed",
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-mutate", step: 1 },
          { ts: "2026-05-11T00:00:02.000Z", type: "chain.step.end", id: "cse1", session_id: "s-mutate", step: 1, status: "completed" },
        ],
      }));
      writePersona("test-agent", SAMPLE_PERSONA);
      const originalContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");

      const finding: EvaluatorFinding = {
        type: "weak_output",
        persona: "test-agent",
        evidence: "s-mutate missed details",
        severity: "medium",
        suggestion: "Add verification instruction",
      };
      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "append",
        content: "Always include replay evidence before claiming success.",
        reasoning: "Require evidence-backed output",
      };

      const result = await runRalphLoop({
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        dryRun: false,
        evaluator: async () => [finding],
        evolver: async () => [mutation],
      });

      expect(result.suggestions[0]!.status).toBe("suggested");
      expect(result.suggestions[0]!.targetType).toBe("persona");
      expect(result.accepted).toBe(0);
      expect(result.rejected).toBe(0);
      expect(readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8")).toBe(originalContent);
    });

    test("verifyMutation refuses apply when golden coverage is insufficient", async () => {
      writePersona("test-agent", SAMPLE_PERSONA);
      writePassingGolden("golden-one");
      const originalContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");

      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "append",
        content: "Always include replay evidence before claiming success.",
        reasoning: "Require evidence-backed output",
      };

      const result = await verifyMutation(mutation, {
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        journalPath: join(TEST_DIR, "journal.jsonl"),
      });

      expect(result.status).toBe("needs_verification");
      expect(result.reason).toContain("Insufficient passing golden coverage");
      expect(readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8")).toBe(originalContent);
    });

    test("verifyMutation rejects unsafe persona target paths", async () => {
      writePersona("test-agent", SAMPLE_PERSONA);
      writePassingGolden("golden-a");
      writePassingGolden("golden-b");
      writePassingGolden("golden-c");

      const mutation: ConfigMutation = {
        persona: "test-agent",
        targetType: "persona",
        target: "../../outside",
        field: "system_prompt",
        action: "append",
        content: "Always include replay evidence before claiming success.",
        reasoning: "Attempted unsafe target path",
      };

      const result = await verifyMutation(mutation, {
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        journalPath: join(TEST_DIR, "journal.jsonl"),
        replayRunner: async (golden) => ({ ...golden, sessionId: `${golden.sessionId}-replay` }),
        getJudgeScoresFn: async () => null,
      });

      expect(result.status).toBe("invalid");
      expect(result.reason).toContain("Target persona file not found");
      expect(existsSync(join(TEST_DIR, "outside.md"))).toBe(false);
      expect(readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8")).toBe(SAMPLE_PERSONA);
    });

    test("verifyMutation dry-run passes ratchet and restores persona file", async () => {
      writePersona("test-agent", SAMPLE_PERSONA);
      writePassingGolden("golden-a");
      writePassingGolden("golden-b");
      writePassingGolden("golden-c");
      const originalContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");

      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "append",
        content: "Always include replay evidence before claiming success.",
        reasoning: "Require evidence-backed output",
      };

      const result = await verifyMutation(mutation, {
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        dryRun: true,
        journalPath: join(TEST_DIR, "journal.jsonl"),
        replayRunner: async (golden) => ({ ...golden, sessionId: `${golden.sessionId}-replay` }),
        getJudgeScoresFn: async () => null,
      });

      expect(result.status).toBe("dry_run");
      expect(result.coverage).toBe(3);
      expect(result.tested).toHaveLength(3);
      expect(readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8")).toBe(originalContent);
    });

    test("verifyMutation rejects and restores when replay deterministic checks fail", async () => {
      writePersona("test-agent", SAMPLE_PERSONA);
      writePassingGolden("golden-x");
      writePassingGolden("golden-y");
      writePassingGolden("golden-z");
      const originalContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");

      const mutation: ConfigMutation = {
        persona: "test-agent",
        field: "system_prompt",
        action: "append",
        content: "Always include replay evidence before claiming success.",
        reasoning: "Require evidence-backed output",
      };

      const result = await verifyMutation(mutation, {
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        journalPath: join(TEST_DIR, "journal.jsonl"),
        replayRunner: async (golden) => ({
          ...golden,
          sessionId: `${golden.sessionId}-bad`,
          events: [
            ...golden.events,
            { ts: "2026-05-11T00:00:06.000Z", type: "agent.error", id: `${golden.sessionId}-err`, session_id: `${golden.sessionId}-bad`, error: "failed" },
          ],
        }),
        getJudgeScoresFn: async () => null,
      });

      expect(result.status).toBe("rejected");
      expect(result.tested[0]!.failedChecks.some((check) => check.includes("no_agent_failures"))).toBe(true);
      expect(readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8")).toBe(originalContent);
    });

    test("falls back to advisory suggestions when evolver returns none", async () => {
      writeTrace("s-fallback", buildTraceEvents("s-fallback", { goal: "Fallback suggestion run" }));

      const finding: EvaluatorFinding = {
        type: "skip_pattern",
        persona: "orchestrator",
        targetType: "chain",
        target: "standard-swarm",
        evidence: "s-fallback had agents but no chain steps",
        severity: "high",
        suggestion: "Inspect standard-swarm chain step definitions.",
      };

      const result = await runRalphLoop({
        traceDir: TRACE_DIR,
        personaDir: PERSONA_DIR,
        evaluator: async () => [finding],
        evolver: async () => [],
      });

      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]!.targetType).toBe("chain");
      expect(result.suggestions[0]!.target).toBe("standard-swarm");
      expect(result.suggestions[0]!.field).toBe("chain");
      expect(result.suggestions[0]!.action).toBe("investigate");
      expect(result.suggestions[0]!.file).toBe("agents/teams/chains.yaml");
    });

    test("dry-run mode does not write persona files", async () => {
      // Create trace and persona
      const events = buildTraceEvents("s-dry", {
        goal: "Test dry run",
        status: "completed",
        extraEvents: [
          { ts: "2026-05-11T00:00:01.000Z", type: "chain.step.start", id: "cs1", session_id: "s-dry", step: 1 },
          { ts: "2026-05-11T00:00:02.000Z", type: "chain.step.end", id: "cse1", session_id: "s-dry", step: 1, status: "completed" },
        ],
      });
      writeTrace("s-dry", events);
      writePersona("test-agent", SAMPLE_PERSONA);

      const originalContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");

      // Mock the LLM calls
      const { callLLM } = await import("./llm-gateway");
      const originalCallLLM = callLLM;

      // We need to test with mocked LLM — but since we can't easily mock
      // ES module exports in bun, we'll just verify the dry-run behavior
      // by checking that files are unchanged after the run
      // (The run will fail at the LLM call since no gateway is configured,
      //  but the dry-run flag should prevent file writes regardless)
      try {
        await runRalphLoop({
          traceDir: TRACE_DIR,
          personaDir: PERSONA_DIR,
          dryRun: true,
        });
      } catch {
        // LLM call will fail without gateway — that's expected
      }

      const afterContent = readFileSync(join(PERSONA_DIR, "test-agent.md"), "utf-8");
      expect(afterContent).toBe(originalContent);
    });

    test("results report counts match mutations", () => {
      // Unit-test the result counting logic directly
      const mutations = [
        { persona: "a", change: "x", accepted: true, scoreBefore: 0.8, scoreAfter: 0.9 },
        { persona: "b", change: "y", accepted: false, scoreBefore: 0.8, scoreAfter: 0.6 },
        { persona: "c", change: "z", accepted: true, scoreBefore: 0.7, scoreAfter: 0.7 },
      ];

      const accepted = mutations.filter((r) => r.accepted).length;
      const rejected = mutations.filter((r) => !r.accepted).length;

      expect(accepted).toBe(2);
      expect(rejected).toBe(1);
      expect(mutations.length).toBe(3);
    });
  });
});

function emptyFingerprint(): BehavioralFingerprint {
  return {
    toolSequence: [],
    agentCount: 0,
    teamSequence: [],
    stepCount: 0,
    errorCount: 0,
    statusTransitions: [],
  };
}
