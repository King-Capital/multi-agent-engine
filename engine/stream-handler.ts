import type { EventEmitter } from "./event-emitter";
import type { SessionState, StreamEvent } from "./types";
import type { OrchestratorLoop } from "./orchestrator-loop";
import { scanSeverity, shouldAutoPause, extractFindingExcerpt } from "./severity-scanner";
import { transitionStatus } from "./session-state";

export interface StreamHandlerOpts {
  emitter: EventEmitter;
  sessionId: string;
  agentId: string;
  trackToolCall: (agentId: string, tool: string) => void;
  messageSenders: Map<string, (msg: string) => void>;
  orchestratorLoop?: OrchestratorLoop | null;
  pausedSessions?: Set<string>;
  session?: SessionState;
}

export function buildStreamHandler(opts: StreamHandlerOpts): (evt: StreamEvent) => void {
  const { emitter, sessionId, agentId, trackToolCall, orchestratorLoop, pausedSessions, session } = opts;

  return (streamEvt: StreamEvent) => {
    if (streamEvt.type === "tool_call") {
      trackToolCall(agentId, streamEvt.tool ?? "");
      emitter.toolCall(sessionId, agentId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
      orchestratorLoop?.recordEvent({
        session_id: sessionId,
        agent_id: agentId,
        event_type: "tool_call",
        timestamp: new Date().toISOString(),
        data: { tool: streamEvt.tool ?? "", status: streamEvt.status ?? "running" },
      });
    } else if (streamEvt.type === "cost") {
      trackToolCall(agentId, "cost_update");
      emitter.costUpdate(sessionId, agentId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
    } else if (streamEvt.type === "assistant_text" && streamEvt.content) {
      trackToolCall(agentId, "assistant_text");
      if (pausedSessions && session && session.status === "active" && !streamEvt.final) {
        const severity = scanSeverity(streamEvt.content);
        if (severity && shouldAutoPause(severity, sessionId)) {
          pausedSessions.add(sessionId);
          transitionStatus(session, "paused", "stream-handler:severity");
          const excerpt = extractFindingExcerpt(streamEvt.content, severity);
          emitter.severityAlert(sessionId, agentId, severity, excerpt);
          emitter.autoPause(sessionId, `severity:${severity}`);
          orchestratorLoop?.trigger("severity_alert", { severity, excerpt });
        }
      }
    }
  };
}

export function buildSendMessage(messageSenders: Map<string, (msg: string) => void>, sessionId: string, agentId: string): (fn: (msg: string) => void) => void {
  return (fn) => {
    messageSenders.set(`${sessionId}:${agentId}`, fn);
  };
}
