import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildJudgePrompt,
  getExistingJudgeScores,
  judgeTrace,
  parseJudgeResponse,
  selectJudgeEvents,
} from "./langfuse-judge";
import type { SessionTrace, TraceEvent } from "./replay";

const originalEnv = { ...process.env };

function event(type: string, overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    ts: "2026-05-12T00:00:00.000Z",
    type,
    id: `${type}-${Math.random()}`,
    session_id: "trace-1",
    ...overrides,
  };
}

function trace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    sessionId: "trace-1",
    goal: "Build a feature",
    chain: "build-verify",
    status: "completed",
    duration_ms: 1000,
    totalCost: 0.25,
    events: [
      event("session.start"),
      event("chain.step.start", { step: 1 }),
      event("llm.call", { model: "sonnet", prompt_tokens: 10, completion_tokens: 5 }),
      event("agent.end", { agent_id: "builder", output_preview: "done" }),
      event("chain.step.end", { step: 1, status: "completed" }),
      event("session.end", { status: "completed" }),
    ],
    ...overrides,
  };
}

describe("langfuse judge", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LANGFUSE_HOST = "http://langfuse.test";
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("selectJudgeEvents keeps high-signal events under the cap", () => {
    const noisy = trace({
      events: [
        ...Array.from({ length: 20 }, (_, i) => event("log", { id: `log-${i}`, level: "INFO" })),
        event("llm.call", { id: "llm-important" }),
        event("agent.error", { id: "error-important" }),
        event("agent.end", { id: "agent-important" }),
      ],
    });

    const selected = selectJudgeEvents(noisy, 5);

    expect(selected.some((e) => e.id === "llm-important")).toBe(true);
    expect(selected.some((e) => e.id === "error-important")).toBe(true);
    expect(selected.some((e) => e.id === "agent-important")).toBe(true);
    expect(selected).toHaveLength(5);
  });

  test("buildJudgePrompt sanitizes and summarizes trace content", () => {
    const prompt = buildJudgePrompt(trace({
      goal: "Review <script>alert(1)</script>",
      events: [event("agent.end", { output_preview: "<script>secret</script> finished" })],
    }));

    expect(prompt).toContain("judge_overall_quality");
    expect(prompt).toContain("Review");
    expect(prompt).not.toContain("<script>");
  });

  test("parseJudgeResponse accepts fenced JSON and clamps scores", () => {
    const parsed = parseJudgeResponse("```json\n{\"judge_overall_quality\":1.2,\"judge_release_readiness\":-1,\"rationale\":\"ok\"}\n```");

    expect(parsed.scores.judge_overall_quality).toBe(1);
    expect(parsed.scores.judge_release_readiness).toBe(0);
    expect(parsed.rationale).toBe("ok");
  });

  test("getExistingJudgeScores returns recent cached scores", async () => {
    const scores = await getExistingJudgeScores("trace-1", {
      fetchImpl: (async () => new Response(JSON.stringify({
        data: [
          { name: "judge_overall_quality", value: 0.8, createdAt: new Date().toISOString() },
          { name: "judge_release_readiness", value: 0.7, createdAt: new Date().toISOString() },
        ],
      }), { status: 200 })) as unknown as typeof fetch,
    });

    expect(scores).toEqual({
      judge_overall_quality: 0.8,
      judge_release_readiness: 0.7,
    });
  });

  test("judgeTrace uses LiteLLM then posts Langfuse scores", async () => {
    const posted: any[] = [];
    const result = await judgeTrace(trace(), {
      explicit: true,
      model: "main",
      llm: async () => JSON.stringify({
        judge_overall_quality: 0.82,
        judge_release_readiness: 0.74,
        rationale: "clean enough",
      }),
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input).includes("/api/public/scores?")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        posted.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(result.cached).toBe(false);
    expect(result.posted).toBe(true);
    expect(result.scores.judge_overall_quality).toBe(0.82);
    expect(posted.map((body) => body.name).sort()).toEqual(["judge_overall_quality", "judge_release_readiness"]);
  });
});
