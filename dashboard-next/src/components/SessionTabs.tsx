/**
 * SessionTabs — tabbed interface for the session detail view.
 * Integrates: Stream | Agents | Till Done | Files | Cost | Replay
 *
 * Uses shared SSE from SessionSSEProvider (parent wraps this).
 */

import * as React from "react";
import {
  Activity,
  Bot,
  CheckSquare,
  DollarSign,
  FolderOpen,
  MessageSquare,
  PlayCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentGraph } from "@/components/AgentGraph";
import { TillDone } from "@/components/TillDone";
import { FilesView } from "@/components/FilesView";
import { CostBreakdown } from "@/components/CostBreakdown";
import { ReplayPlayer } from "@/components/ReplayPlayer";
import { api } from "@/lib/api";
import { usePolling } from "@/hooks/usePolling";
import { useSessionSSE } from "@/hooks/useSessionSSE";
import type { DBSession, DBEvent, LiveEvent, LiveAgent } from "@/lib/types";
import { cn, formatCurrency, formatDurationMs, formatNumber, shortId, statusColor } from "@/lib/utils";

// ─── Inline event row (stream tab) ───────────────────────────────────────────

const EVENT_COLOR: Record<string, string> = {
  agent_spawn: "text-purple-400",
  agent_done: "text-emerald-400",
  message: "text-cyan-400",
  tool_call: "text-amber-400",
  cost_update: "text-yellow-400",
  error: "text-red-400",
  tilldone: "text-teal-400",
  domain_block: "text-orange-400",
  self_heal: "text-amber-300",
  session_start: "text-cyan-300",
  session_end: "text-zinc-400",
  waiting: "text-zinc-400",
  pause: "text-amber-400",
  resume: "text-cyan-400",
};

function LiveEventRow({ ev, active }: { ev: LiveEvent; active?: boolean }) {
  const d = ev.data ?? {};
  const summary = String(
    d.content || d.error_msg || d.tool || d.agent_name || d.grade || "",
  ).slice(0, 140);
  return (
    <div
      className={cn(
        "grid grid-cols-[84px_130px_1fr] gap-3 rounded px-2 py-1.5 text-xs",
        active && "bg-cyan-400/10 ring-1 ring-cyan-400/30",
      )}
    >
      <span className="text-slate-500">
        {new Date(ev.timestamp ?? Date.now()).toLocaleTimeString()}
      </span>
      <span className={cn("font-medium", EVENT_COLOR[ev.event_type] ?? "text-slate-300")}>
        {ev.event_type}
      </span>
      <span className="truncate text-slate-300">{summary}</span>
    </div>
  );
}

// ─── Stream tab ───────────────────────────────────────────────────────────────

interface StreamTabProps {
  sessionId: string;
  liveEvents: LiveEvent[];
  historyEvents: DBEvent[];
  streamError: string | null;
  message: string;
  sendError: string | null;
  onMessageChange: (v: string) => void;
  onSend: () => void;
}

function StreamTab({
  liveEvents,
  historyEvents,
  streamError,
  message,
  sendError,
  onMessageChange,
  onSend,
}: StreamTabProps) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveEvents.length]);

  const allEvents: LiveEvent[] = React.useMemo(() => {
    const hist: LiveEvent[] = historyEvents.map((e) => {
      const p = e.payload as LiveEvent | null;
      return {
        session_id: e.session_id,
        agent_id: e.agent_id ?? "",
        event_type: e.event_type,
        timestamp: p?.timestamp ?? e.created_at,
        data: p?.data,
        cost_usd: p?.cost_usd,
        tokens_used: p?.tokens_used,
      };
    });
    // Merge, live events at the end
    return [...hist, ...liveEvents];
  }, [historyEvents, liveEvents]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {streamError && (
        <p className="text-xs text-amber-400 px-3 py-1.5 bg-amber-950/30 border-b border-amber-900/40">
          {streamError}
        </p>
      )}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5 font-mono">
          {allEvents.length === 0 && (
            <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
              Waiting for events…
            </div>
          )}
          {allEvents.map((ev, i) => (
            <LiveEventRow key={`${ev.event_type}-${ev.timestamp ?? ""}-${i}`} ev={ev} />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
      <div className="border-t border-zinc-800 p-3 space-y-2">
        {sendError && (
          <p className="text-xs text-red-400">{sendError}</p>
        )}
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            placeholder="Steer the orchestrator…"
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSend();
            }}
          />
          <Button size="sm" onClick={onSend} disabled={!message.trim()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Cost tab ─────────────────────────────────────────────────────────────────

function CostTab({ sessionId }: { sessionId: string }) {
  const { data: agents, loading, error } = usePolling(
    (signal) => api.sessionAgents(sessionId, signal),
    15_000,
    [sessionId],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        Loading cost data…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-32 text-red-400 text-sm">
        {error}
      </div>
    );
  }

  return <CostBreakdown agents={agents ?? []} />;
}

// ─── Main SessionTabs component ───────────────────────────────────────────────

interface SessionTabsProps {
  session: DBSession;
  historyEvents: DBEvent[];
  onRefresh: () => void;
}

export function SessionTabs({
  session,
  historyEvents,
  onRefresh,
}: SessionTabsProps) {
  const [tab, setTab] = React.useState("stream");
  const [message, setMessage] = React.useState("");
  const [sendError, setSendError] = React.useState<string | null>(null);

  // Use shared SSE from context
  const { events: liveEvents, error: streamError } = useSessionSSE();

  const totals = React.useMemo(() => {
    const duration = session.completed_at
      ? new Date(session.completed_at).getTime() - new Date(session.created_at).getTime()
      : Date.now() - new Date(session.created_at).getTime();
    return { duration };
  }, [session]);

  async function handleSend() {
    if (!message.trim()) return;
    setSendError(null);
    try {
      await api.sendMessage(session.id, message.trim());
      setMessage("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    }
  }

  return (
    <main className="min-w-0 flex-1 overflow-hidden flex flex-col">
      {/* Session header */}
      <div className="border-b border-white/10 bg-slate-950/60 px-4 py-3 md:px-6 shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-zinc-100">{session.name}</h2>
              <Badge className={statusColor(session.status)} variant="outline">
                {session.status}
              </Badge>
              {session.chain && (
                <Badge variant="secondary">{session.chain}</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {shortId(session.id)} · {session.platform} ·{" "}
              {new Date(session.created_at).toLocaleString()} ·{" "}
              {formatDurationMs(totals.duration)}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6 gap-3 overflow-auto">
        <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="stream">
              <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
              Stream
            </TabsTrigger>
            <TabsTrigger value="agents">
              <Bot className="w-3.5 h-3.5 mr-1.5" />
              Agents
            </TabsTrigger>
            <TabsTrigger value="tilldone">
              <CheckSquare className="w-3.5 h-3.5 mr-1.5" />
              Progress
            </TabsTrigger>
            <TabsTrigger value="files">
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="cost">
              <DollarSign className="w-3.5 h-3.5 mr-1.5" />
              Cost
            </TabsTrigger>
            <TabsTrigger value="replay">
              <PlayCircle className="w-3.5 h-3.5 mr-1.5" />
              Replay
            </TabsTrigger>
          </TabsList>

          {/* Stream tab */}
          <TabsContent value="stream" className="flex-1 min-h-0">
            <Card className="glass flex flex-col h-full" style={{ minHeight: "calc(100vh - 280px)" }}>
              <CardHeader className="py-3 px-4 shrink-0 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  Live event stream
                  <span className="ml-auto text-xs text-zinc-500 font-normal">
                    {liveEvents.length} live · {historyEvents.length} historical
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 p-0">
                <StreamTab
                  sessionId={session.id}
                  liveEvents={liveEvents}
                  historyEvents={historyEvents}
                  streamError={streamError}
                  message={message}
                  sendError={sendError}
                  onMessageChange={setMessage}
                  onSend={() => void handleSend()}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Agents tab */}
          <TabsContent value="agents" className="flex-1 min-h-0">
            <Card className="glass">
              <CardHeader className="py-3 px-4 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Bot className="w-4 h-4 text-cyan-400" />
                  Agent graph
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <AgentGraph
                  sessionId={session.id}
                  events={historyEvents}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* TillDone / Progress tab */}
          <TabsContent value="tilldone" className="flex-1 min-h-0">
            <Card className="glass">
              <CardHeader className="py-3 px-4 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CheckSquare className="w-4 h-4 text-cyan-400" />
                  Till-done progress
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <TillDone sessionId={session.id} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Files tab */}
          <TabsContent value="files" className="flex-1 min-h-0">
            <Card className="glass">
              <CardHeader className="py-3 px-4 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FolderOpen className="w-4 h-4 text-cyan-400" />
                  Files changed
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <FilesView sessionId={session.id} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Cost tab */}
          <TabsContent value="cost" className="flex-1 min-h-0">
            <Card className="glass">
              <CardHeader className="py-3 px-4 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <DollarSign className="w-4 h-4 text-cyan-400" />
                  Cost breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <CostTab sessionId={session.id} />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Replay tab */}
          <TabsContent value="replay" className="flex-1 min-h-0">
            <ReplayPlayer sessionId={session.id} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
