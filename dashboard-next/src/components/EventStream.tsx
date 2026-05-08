import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MessageSquare,
  Wrench,
  Zap,
  AlertCircle,
  Bot,
  CheckCircle2,
  LogIn,
  LogOut,
  Clock,
  Pause,
  Play,
  Loader2,
  Send,
  WifiOff,
} from "lucide-react";
import { api } from "@/lib/api";
import { useEventStream } from "@/hooks/useEventStream";
import type { LiveEvent, DBEvent } from "@/lib/types";
import { cn, relativeTime } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// ─── Event type metadata ──────────────────────────────────────────────────────

interface EventMeta {
  icon: React.ReactNode;
  label: string;
  colorClass: string;
}

function getEventMeta(eventType: string): EventMeta {
  switch (eventType) {
    case "session_start":
      return { icon: <LogIn className="h-3.5 w-3.5" />, label: "Session Start", colorClass: "text-cyan-400" };
    case "session_end":
      return { icon: <LogOut className="h-3.5 w-3.5" />, label: "Session End", colorClass: "text-zinc-400" };
    case "agent_spawn":
      return { icon: <Bot className="h-3.5 w-3.5" />, label: "Agent Spawned", colorClass: "text-purple-400" };
    case "agent_done":
      return { icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: "Agent Done", colorClass: "text-emerald-400" };
    case "message":
      return { icon: <MessageSquare className="h-3.5 w-3.5" />, label: "Message", colorClass: "text-blue-400" };
    case "tool_call":
      return { icon: <Wrench className="h-3.5 w-3.5" />, label: "Tool Call", colorClass: "text-amber-400" };
    case "cost_update":
      return { icon: <Zap className="h-3.5 w-3.5" />, label: "Cost Update", colorClass: "text-yellow-400" };
    case "error":
      return { icon: <AlertCircle className="h-3.5 w-3.5" />, label: "Error", colorClass: "text-red-400" };
    case "tilldone":
      return { icon: <CheckCircle2 className="h-3.5 w-3.5" />, label: "Till Done", colorClass: "text-emerald-300" };
    case "pause":
      return { icon: <Pause className="h-3.5 w-3.5" />, label: "Paused", colorClass: "text-amber-400" };
    case "resume":
      return { icon: <Play className="h-3.5 w-3.5" />, label: "Resumed", colorClass: "text-cyan-400" };
    case "waiting":
      return { icon: <Clock className="h-3.5 w-3.5" />, label: "Waiting", colorClass: "text-zinc-400" };
    case "domain_block":
      return { icon: <AlertCircle className="h-3.5 w-3.5" />, label: "Domain Block", colorClass: "text-red-400" };
    case "self_heal":
      return { icon: <Zap className="h-3.5 w-3.5" />, label: "Self Heal", colorClass: "text-amber-300" };
    default:
      return { icon: <Zap className="h-3.5 w-3.5" />, label: eventType, colorClass: "text-zinc-400" };
  }
}

// Hashed colour for agent IDs
function agentColor(agentId: string): string {
  const colours = [
    "bg-violet-500/20 text-violet-300 ring-violet-500/30",
    "bg-blue-500/20 text-blue-300 ring-blue-500/30",
    "bg-emerald-500/20 text-emerald-300 ring-emerald-500/30",
    "bg-amber-500/20 text-amber-300 ring-amber-500/30",
    "bg-rose-500/20 text-rose-300 ring-rose-500/30",
    "bg-pink-500/20 text-pink-300 ring-pink-500/30",
    "bg-cyan-500/20 text-cyan-300 ring-cyan-500/30",
    "bg-orange-500/20 text-orange-300 ring-orange-500/30",
  ];
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return colours[hash % colours.length];
}

// ─── Single event row ─────────────────────────────────────────────────────────

function EventRow({ event, ts }: { event: LiveEvent; ts: string }) {
  const meta = getEventMeta(event.event_type);
  const data = event.data;
  const agentId = event.agent_id;

  // Build a human-readable summary
  let summary = "";
  if (data?.content) summary = data.content;
  else if (data?.error_msg) summary = data.error_msg;
  else if (data?.tool) summary = `${data.tool}${data.tool_args ? ` (${String(data.tool_args).slice(0, 60)})` : ""}`;
  else if (data?.agent_name) summary = data.agent_name;
  else if (data?.session_name) summary = data.session_name;
  else if (data?.heal_action) summary = data.heal_action;
  else if (data?.block_reason) summary = data.block_reason;

  return (
    <div className="group flex gap-3 px-4 py-2.5 hover:bg-zinc-800/30 transition-colors">
      {/* Icon */}
      <div className={cn("mt-0.5 flex-shrink-0", meta.colorClass)}>{meta.icon}</div>

      {/* Body */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Event type label */}
          <span className={cn("text-xs font-semibold", meta.colorClass)}>{meta.label}</span>

          {/* Agent badge */}
          {agentId && (
            <span
              className={cn(
                "rounded ring-1 px-1.5 py-0 text-[10px] font-medium",
                agentColor(agentId)
              )}
            >
              {agentId.length > 12 ? agentId.slice(0, 12) + "…" : agentId}
            </span>
          )}

          {/* Cost */}
          {event.cost_usd != null && event.cost_usd > 0 && (
            <span className="text-[10px] text-amber-400/80">
              ${event.cost_usd.toFixed(4)}
            </span>
          )}

          {/* Timestamp */}
          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">
            {ts}
          </span>
        </div>

        {/* Summary text */}
        {summary && (
          <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3 break-words">
            {summary}
          </p>
        )}

        {/* TillDone checklist */}
        {data?.tilldone && (
          <div className="mt-1 flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
              {data.tilldone.title} — {data.tilldone.completed}/{data.tilldone.total}
            </span>
            {data.tilldone.items.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <span
                  className={cn(
                    "h-3 w-3 flex-shrink-0 rounded-full border",
                    item.completed
                      ? "border-emerald-500 bg-emerald-500/30"
                      : item.active
                        ? "border-cyan-500 bg-cyan-500/20"
                        : "border-zinc-600"
                  )}
                />
                <span
                  className={cn(
                    item.completed ? "text-zinc-500 line-through" : "text-zinc-300"
                  )}
                >
                  {item.description}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Convert DBEvent → LiveEvent ──────────────────────────────────────────────

function dbEventToLive(evt: DBEvent): LiveEvent {
  const payload = evt.payload as LiveEvent | null;
  return {
    session_id: evt.session_id,
    agent_id: evt.agent_id ?? "",
    event_type: evt.event_type,
    timestamp: payload?.timestamp ?? evt.created_at,
    tokens_used: payload?.tokens_used,
    cost_usd: payload?.cost_usd,
    context_tokens: payload?.context_tokens,
    data: payload?.data,
  };
}

// ─── Main EventStream component ───────────────────────────────────────────────

interface EventStreamProps {
  sessionId: string;
}

export default function EventStream({ sessionId }: EventStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // ── Historical events from Postgres ──
  const { data: historicalEvents, isLoading: histLoading } = useQuery({
    queryKey: ["events", sessionId],
    queryFn: () => api.sessionEvents(sessionId),
    staleTime: Infinity, // history doesn't change; live events handle updates
  });

  // ── Live events via SSE ──
  const { events: liveEvents, connected, error: streamError } = useEventStream({
    sessionId,
    maxEvents: 500,
  });

  // ── Merge: history first, then live (dedup by composite key) ──
  const allEvents: Array<{ key: string; event: LiveEvent; ts: string }> = [];
  const seen = new Set<string>();

  // Historical
  if (historicalEvents) {
    for (const dbEvt of historicalEvents) {
      const key = `db-${dbEvt.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        allEvents.push({
          key,
          event: dbEventToLive(dbEvt),
          ts: relativeTime(dbEvt.created_at),
        });
      }
    }
  }

  // Live
  for (let i = 0; i < liveEvents.length; i++) {
    const evt = liveEvents[i];
    const key = `live-${evt.session_id}-${evt.event_type}-${evt.timestamp ?? i}`;
    if (!seen.has(key)) {
      seen.add(key);
      allEvents.push({
        key,
        event: evt,
        ts: relativeTime(evt.timestamp),
      });
    }
  }

  // ── Auto-scroll ──
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [allEvents.length, autoScroll]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  }, []);

  // ── Send message ──
  const handleSend = useCallback(async () => {
    const msg = message.trim();
    if (!msg) return;
    setSending(true);
    setSendError(null);
    try {
      await api.sendMessage(sessionId, msg);
      setMessage("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }, [message, sessionId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  // ── Render ──
  return (
    <div className="flex h-full flex-col">
      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {allEvents.length} events
        </span>
        <div className="flex items-center gap-1.5 ml-auto">
          {streamError && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <WifiOff className="h-3 w-3" />
              {streamError}
            </span>
          )}
          <span
            className={cn(
              "flex items-center gap-1 text-[11px] font-medium",
              connected ? "text-cyan-400" : "text-zinc-500"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-cyan-400 animate-pulse" : "bg-zinc-600"
              )}
            />
            {connected ? "Live" : "Disconnected"}
          </span>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                bottomRef.current?.scrollIntoView({ behavior: "smooth" });
              }}
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              ↓ Jump to bottom
            </button>
          )}
        </div>
      </div>

      {/* Event feed */}
      <div
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        {histLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading history…
          </div>
        )}

        {!histLoading && allEvents.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Zap className="h-8 w-8 text-zinc-700" />
            <span>Waiting for events…</span>
          </div>
        )}

        <div className="divide-y divide-border/30">
          {allEvents.map(({ key, event, ts }) => (
            <EventRow key={key} event={event} ts={ts} />
          ))}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Message input */}
      <div className="border-t border-border/60 bg-zinc-950/60 p-3">
        {sendError && (
          <p className="mb-2 text-xs text-red-400">{sendError}</p>
        )}
        <div className="flex gap-2">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message to this session…"
            className="flex-1 bg-zinc-900 border-zinc-700 text-sm"
            disabled={sending}
          />
          <Button
            onClick={() => void handleSend()}
            disabled={sending || !message.trim()}
            size="icon"
            className="flex-shrink-0"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
