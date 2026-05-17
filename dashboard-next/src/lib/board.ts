import type { LiveEvent } from "./types";

export type BoardColumn = "planned" | "in-progress" | "review" | "blocked" | "done";

export interface BoardCard {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  model?: string;
  column: BoardColumn;
  detail?: string;
}

export function buildBoardCards(events: LiveEvent[]): BoardCard[] {
  const cards = new Map<string, BoardCard>();
  for (const event of events) {
    const data = event.data ?? {};
    if (event.event_type === "agent_spawn" && event.agent_id) {
      cards.set(event.agent_id, {
        id: event.agent_id,
        title: data.agent_name ?? event.agent_id,
        agentId: event.agent_id,
        agentName: data.agent_name,
        model: data.model,
        column: "in-progress",
        detail: data.team_name,
      });
    }
    if (event.event_type === "agent_done" && event.agent_id) {
      const existing = cards.get(event.agent_id);
      cards.set(event.agent_id, {
        id: event.agent_id,
        title: existing?.title ?? data.agent_name ?? event.agent_id,
        agentId: event.agent_id,
        agentName: existing?.agentName ?? data.agent_name,
        model: existing?.model ?? data.model,
        column: data.grade && data.grade !== "VERIFIED" ? "review" : "done",
        detail: data.grade,
      });
    }
    if ((event.event_type === "error" || event.event_type === "agent_error" || event.event_type === "domain_block" || event.event_type === "severity_alert") && event.agent_id) {
      const existing = cards.get(event.agent_id);
      cards.set(event.agent_id, {
        id: event.agent_id,
        title: existing?.title ?? data.agent_name ?? event.agent_id,
        agentId: event.agent_id,
        agentName: existing?.agentName ?? data.agent_name,
        model: existing?.model ?? data.model,
        column: "blocked",
        detail: data.error_msg ?? data.block_reason ?? data.severity ?? "Needs attention",
      });
    }
    if (event.event_type === "tilldone" && Array.isArray(data.tilldone?.items)) {
      for (const [index, item] of data.tilldone.items.entries()) {
        const id = `tilldone-${index}-${item.description}`;
        cards.set(id, {
          id,
          title: item.description,
          column: item.completed ? "done" : item.active ? "in-progress" : "planned",
          detail: data.tilldone.title,
        });
      }
    }
  }
  return [...cards.values()];
}
