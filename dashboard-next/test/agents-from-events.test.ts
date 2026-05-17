import { describe, expect, test } from "bun:test";
import { buildAgentsFromEvents } from "../src/lib/agents-from-events";
import type { DBEvent } from "../src/lib/types";

function event(event_type: string, payload: Record<string, unknown>): DBEvent {
  return {
    id: 1,
    session_id: "s1",
    agent_id: String(payload.agent_id ?? "orch-1"),
    event_type,
    payload: {
      session_id: "s1",
      agent_id: String(payload.agent_id ?? "orch-1"),
      event_type,
      timestamp: "2026-05-11T00:00:00.000Z",
      ...payload,
    },
    created_at: "2026-05-11T00:00:00.000Z",
  };
}

describe("buildAgentsFromEvents", () => {
  test("reads agent_done cost from nested data payloads", () => {
    const agents = buildAgentsFromEvents([
      event("agent_spawn", {
        agent_id: "orch-1",
        data: {
          agent_name: "Orchestrator",
          agent_role: "orchestrator",
          model: "quality",
          team_name: "Orchestration",
          team_color: "#36f9f6",
        },
      }),
      event("agent_done", {
        agent_id: "orch-1",
        data: {
          grade: "VERIFIED",
          cost_usd: 0.02,
          output_artifact: "s1/artifacts/orch.txt",
          task_report: "s1/RALPH/orch.md",
        },
      }),
    ]);

    expect(agents[0]?.cost_usd).toBe(0.02);
    expect(agents[0]?.status).toBe("done");
    expect(agents[0]?.output_artifact).toBe("s1/artifacts/orch.txt");
    expect(agents[0]?.task_report).toBe("s1/RALPH/orch.md");
  });
});
