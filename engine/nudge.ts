import { $ } from "bun";
import type { AgentActivity } from "./monitoring";
import type { EventEmitter } from "./event-emitter";
import type { SessionState, PlatformAdapter } from "./types";

export interface NudgeState {
  agentId: string;
  nudgeCount: number;
  lastNudgeAt: number;
  escalated: boolean;
  webSearchUsed: boolean;
}

const NUDGE_COOLDOWN_MS = 30_000;

const RULE_BASED_NUDGES = [
  "You appear to be idle. Please continue working on your assigned task, or report if you're blocked.",
  "Still waiting for progress. If you need clarification, describe what's blocking you.",
  "Final nudge before escalation. Please resume work or explain your blocker.",
];

export function createNudgeState(agentId: string): NudgeState {
  return {
    agentId,
    nudgeCount: 0,
    lastNudgeAt: 0,
    escalated: false,
    webSearchUsed: false,
  };
}

export function shouldNudge(state: NudgeState, now: number): boolean {
  if (state.lastNudgeAt === 0) return true;
  return now - state.lastNudgeAt >= NUDGE_COOLDOWN_MS;
}

export function getRuleBasedNudge(nudgeCount: number): string {
  const idx = Math.min(nudgeCount, RULE_BASED_NUDGES.length - 1);
  return RULE_BASED_NUDGES[idx]!;
}

export async function generateLLMNudge(
  adapter: PlatformAdapter,
  agentName: string,
  lastTool: string,
  idleSeconds: number,
  taskContext: string,
): Promise<string> {
  try {
    const result = await adapter.delegate({
      persona: {
        name: "NudgeAdvisor",
        model: "sonnet",
        expertise: "",
        skills: [],
        tools: [],
        domain: { read: [], write: [], update: [] },
      },
      systemPrompt: "You are a brief assistant. Respond with ONE actionable sentence only.",
      userPrompt: `Agent "${agentName}" has been idle for ${idleSeconds}s after using tool "${lastTool}". Their task: "${taskContext.slice(0, 300)}". Generate a specific, actionable nudge to help them resume.`,
      model: "sonnet",
      thinking: "off",
      tools: [],
      domain: { read: [], write: [], update: [] },
      workingDir: "/tmp",
      sessionDir: "/tmp/nudge",
      teamName: "monitor",
      teamColor: "#888",
      timeoutMs: 15_000,
    });
    return result.output.trim() || getRuleBasedNudge(3);
  } catch {
    return getRuleBasedNudge(3);
  }
}

let surfAvailable: boolean | null = null;

async function checkSurfAvailable(): Promise<boolean> {
  if (surfAvailable !== null) return surfAvailable;
  try {
    await $`which mcp2cli`.quiet();
    await $`mcp2cli surf --help`.quiet();
    surfAvailable = true;
  } catch {
    surfAvailable = false;
  }
  return surfAvailable;
}

export async function webSearchNudge(
  problemContext: string,
): Promise<string | null> {
  if (!(await checkSurfAvailable())) return null;
  try {
    const result = await $`mcp2cli surf search ${problemContext.slice(0, 200)}`.text();
    const trimmed = result.trim();
    if (!trimmed) return null;
    return `I researched your blocker and found some approaches:\n${trimmed.slice(0, 1500)}`;
  } catch {
    return null;
  }
}

export async function executeNudge(
  state: NudgeState,
  activity: AgentActivity,
  session: SessionState,
  emitter: EventEmitter,
  messageSender: ((msg: string) => void) | undefined,
  adapter?: PlatformAdapter,
): Promise<void> {
  const now = Date.now();
  if (!shouldNudge(state, now)) return;

  const idleSeconds = Math.round((now - activity.lastEventAt) / 1000);
  let nudgeMessage: string;
  let nudgeType: "rule_based" | "llm_escalated" | "web_search" = "rule_based";

  if (state.nudgeCount < 3) {
    nudgeMessage = getRuleBasedNudge(state.nudgeCount);
  } else if (state.nudgeCount >= 4 && !state.webSearchUsed && (activity.role === "lead" || activity.role === "sr")) {
    const searchResult = await webSearchNudge(
      `${activity.lastTool} stuck ${session.task}`,
    );
    if (searchResult) {
      nudgeMessage = searchResult;
      nudgeType = "web_search";
      state.webSearchUsed = true;
    } else {
      nudgeMessage = await generateLLMNudge(
        adapter!,
        activity.name,
        activity.lastTool,
        idleSeconds,
        session.task,
      );
      nudgeType = "llm_escalated";
    }
  } else if (adapter) {
    nudgeMessage = await generateLLMNudge(
      adapter,
      activity.name,
      activity.lastTool,
      idleSeconds,
      session.task,
    );
    nudgeType = "llm_escalated";
    state.escalated = true;
  } else {
    nudgeMessage = getRuleBasedNudge(state.nudgeCount);
  }

  messageSender?.(nudgeMessage);

  await emitter.nudgeSent(
    session.id,
    state.agentId,
    activity.name,
    nudgeType,
    state.nudgeCount + 1,
    nudgeMessage,
  );

  state.nudgeCount++;
  state.lastNudgeAt = now;
}
