import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CircleDollarSign,
  HeartPulse,
  Users,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, API_BASE_URL } from "@/lib/api";
import type { DBEvent, DBSession, LiveEvent } from "@/lib/types";
import {
  cn,
  formatCurrency,
  formatNumber,
  shortId,
} from "@/lib/utils";
import { usePolling } from "@/hooks/usePolling";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SessionTabs } from "@/components/SessionTabs";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusClass(status: string) {
  if (["completed", "done"].includes(status))
    return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (["active", "running", "waiting"].includes(status))
    return "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
  if (["failed", "error", "blocked"].includes(status))
    return "bg-red-500/15 text-red-300 border-red-500/30";
  return "bg-slate-500/15 text-slate-300 border-slate-500/30";
}

// ─── Stats panel ──────────────────────────────────────────────────────────────

function StatsPanel() {
  const { data, loading, error } = usePolling(api.stats, 15_000, []);
  if (loading)
    return (
      <Card className="glass">
        <CardContent className="p-5 text-sm text-slate-400">
          Loading stats...
        </CardContent>
      </Card>
    );
  if (error || !data)
    return (
      <Card className="glass">
        <CardContent className="p-5 text-sm text-red-300">
          Stats unavailable: {error}
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(
          [
            ["Sessions", formatNumber(data.total_sessions), Activity],
            ["Agents", formatNumber(data.total_agents), Users],
            ["Total Cost", formatCurrency(data.total_cost), CircleDollarSign],
            ["Events", formatNumber(data.total_events), Zap],
          ] as const
        ).map(([label, value, Icon]) => (
          <Card key={String(label)} className="glass">
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {String(label)}
                </p>
                <p className="mt-1 text-2xl font-bold">{String(value)}</p>
              </div>
              {React.createElement(Icon as typeof Activity, {
                className: "text-cyan-300",
              })}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle>Cost per day</CardTitle>
            <CardDescription>Last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer>
              <AreaChart data={data.cost_per_day}>
                <defs>
                  <linearGradient id="cost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="day" stroke="#64748b" fontSize={12} />
                <YAxis stroke="#64748b" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "#020617",
                    border: "1px solid #334155",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="#22d3ee"
                  fill="url(#cost)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle>Top chains</CardTitle>
            <CardDescription>By total agent cost</CardDescription>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer>
              <BarChart data={data.top_chains}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="chain" stroke="#64748b" fontSize={12} />
                <YAxis stroke="#64748b" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "#020617",
                    border: "1px solid #334155",
                  }}
                />
                <Bar dataKey="cost" fill="#a78bfa" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Session sidebar ──────────────────────────────────────────────────────────

function SessionSidebar({
  sessions,
  selectedId,
  onSelect,
  loading,
  error,
}: {
  sessions: DBSession[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const filtered = sessions.filter((s) =>
    `${s.name} ${s.id} ${s.chain ?? ""} ${s.status}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <aside className="flex h-screen w-full flex-col border-r border-white/10 bg-slate-950/80 md:w-96">
      <div className="p-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-xl bg-cyan-400/10 p-2 text-cyan-300">
            <Zap size={22} />
          </div>
          <div>
            <h1 className="font-bold">MAE Dashboard</h1>
            <p className="text-xs text-slate-500">{API_BASE_URL || "proxy"}</p>
          </div>
        </div>
        <Input
          placeholder="Search sessions..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="mt-2 text-xs text-slate-500">
          {loading ? "Refreshing..." : `${filtered.length} sessions`}
          {error && <span className="text-red-300"> · {error}</span>}
        </div>
      </div>

      <ScrollArea className="flex-1 px-3 pb-3">
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
            No sessions found.
          </div>
        )}
        <div className="space-y-2">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "w-full rounded-xl border p-3 text-left transition hover:bg-white/5",
                selectedId === s.id
                  ? "border-cyan-400/40 bg-cyan-400/10"
                  : "border-white/10 bg-white/[0.02]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{s.name}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    {shortId(s.id)} · {new Date(s.created_at).toLocaleString()}
                  </div>
                </div>
                <Badge className={statusClass(s.status)} variant="outline">
                  {s.status}
                </Badge>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
                {s.chain && <Badge variant="secondary">{s.chain}</Badge>}
                <span>{s.platform}</span>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}

// ─── Session detail (tabbed) ──────────────────────────────────────────────────

function Detail({ session }: { session: DBSession }) {
  const {
    data: history,
    loading: eventsLoading,
    error: eventsError,
    refresh,
  } = usePolling(() => api.sessionEvents(session.id), 10_000, [session.id]);

  const [live, setLive] = useState<LiveEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  // Open SSE stream
  useEffect(() => {
    setLive([]);
    setStreamError(null);
    const es = new EventSource(api.streamUrl(session.id));
    const handler = (e: MessageEvent) => {
      try {
        setLive((v) => [JSON.parse(e.data), ...v].slice(0, 300));
      } catch {
        /* ignore */
      }
    };
    es.onmessage = handler;
    [
      "session_start",
      "session_end",
      "agent_spawn",
      "agent_done",
      "message",
      "tool_call",
      "tilldone",
      "cost_update",
      "domain_block",
      "self_heal",
      "error",
      "pause",
      "resume",
      "waiting",
    ].forEach((t) => es.addEventListener(t, handler as EventListener));
    es.onerror = () => setStreamError("SSE reconnecting or unavailable");
    return () => es.close();
  }, [session.id]);

  return (
    <SessionTabs
      session={session}
      liveEvents={live}
      historyEvents={history ?? []}
      streamError={streamError}
      onRefresh={refresh}
    />
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const { data: sessions, loading, error } = usePolling(api.sessions, 5_000, []);
  const { data: health } = usePolling(api.health, 30_000, []);
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    if (!selectedId && sessions?.[0]) setSelectedId(sessions[0].id);
  }, [sessions, selectedId]);

  const selected = sessions?.find((s) => s.id === selectedId);

  return (
    <div className="min-h-screen bg-grid">
      <div className="flex min-h-screen flex-col md:flex-row">
        <SessionSidebar
          sessions={sessions ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loading}
          error={error}
        />

        {selected ? (
          <Detail session={selected} />
        ) : (
          <main className="flex flex-1 items-center justify-center p-6">
            <Card className="glass max-w-4xl w-full">
              <CardHeader>
                <CardTitle>Select a session</CardTitle>
                <CardDescription>
                  Choose a run from the sidebar to inspect live events, agent
                  graph, till-done progress, files changed, and cost breakdown.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StatsPanel />
                <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                  <HeartPulse size={14} />
                  API: {health?.status || "checking"} · DB:{" "}
                  {health?.db || "unknown"}
                </p>
              </CardContent>
            </Card>
          </main>
        )}
      </div>
    </div>
  );
}
