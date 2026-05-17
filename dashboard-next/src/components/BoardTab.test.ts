import { describe, expect, test } from "bun:test";
import { buildBoardCards } from "../lib/board";
import type { LiveEvent } from "../lib/types";

const base = { session_id: "s1", timestamp: "2026-01-01T00:00:00Z" };

describe("buildBoardCards", () => {
  test("places spawned, completed, blocked, and tilldone work in board columns", () => {
    const events: LiveEvent[] = [
      { ...base, agent_id: "a1", event_type: "agent_spawn", data: { agent_name: "Worker", model: "sonnet", team_name: "Build" } },
      { ...base, agent_id: "a2", event_type: "agent_spawn", data: { agent_name: "Reviewer", model: "opus", team_name: "Review" } },
      { ...base, agent_id: "a1", event_type: "agent_done", data: { grade: "VERIFIED" } },
      { ...base, agent_id: "a2", event_type: "error", data: { error_msg: "failed" } },
      { ...base, agent_id: "orch-1", event_type: "tilldone", data: { tilldone: { title: "checks", completed: 1, total: 2, items: [{ description: "build", completed: true, active: false }, { description: "deploy", completed: false, active: true }] } } },
    ];

    const cards = buildBoardCards(events);
    expect(cards.find((card) => card.id === "a1")?.column).toBe("done");
    expect(cards.find((card) => card.id === "a2")?.column).toBe("blocked");
    expect(cards.find((card) => card.title === "deploy")?.column).toBe("in-progress");
  });
});
