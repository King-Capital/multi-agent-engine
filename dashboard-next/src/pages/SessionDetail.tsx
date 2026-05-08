import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Clock,
  DollarSign,
  FileText,
  Hash,
  Layers,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import EventStream from "@/components/EventStream";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, statusColor, statusDot, relativeTime, formatCost, formatDuration } from "@/lib/utils";

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card className="bg-zinc-900/60 border-zinc-800">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn("rounded-md p-2 text-zinc-400", accent)}>{icon}</div>
        <div className="flex flex-col">
          <span className="text-lg font-bold text-foreground">{value}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Agent list ───────────────────────────────────────────────────────────────

function AgentList({ sessionId }: { sessionId: string }) {
  const { data: agents, isLoading } = useQuery({
    queryKey: ["agents", sessionId],
    queryFn: () => api.sessionAgents(sessionId),
    refetchInterval: 5_000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg bg-zinc-800/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        No agents recorded yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/40">
      {agents.map((agent) => (
        <div key={agent.id} className="flex items-center gap-3 px-4 py-3">
          <Bot className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* LiveAgent has .name; DBAgent has .agent_id — use name with id fallback */}
            <span className="truncate text-sm font-medium">
              {("name" in agent ? agent.name : null) || ("agent_id" in agent ? (agent as {agent_id: string}).agent_id : agent.id)}
            </span>
            <span className="text-[11px] text-muted-foreground">{agent.role}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {agent.cost_usd > 0 && (
              <span className="text-xs text-amber-400">{formatCost(agent.cost_usd)}</span>
            )}
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider",
                statusColor(agent.status)
              )}
            >
              {agent.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Diff view ────────────────────────────────────────────────────────────────

function DiffView({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: ["diff", sessionId],
    queryFn: () => api.sessionDiff(sessionId),
    staleTime: 30_000,
  });

  if (!data || data.files.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        No file activity recorded.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/40 p-2">
      {data.files.map((f, i) => (
        <div key={i} className="flex items-center gap-2 px-3 py-1.5">
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-mono text-zinc-300">
            {typeof f === "string" ? f : f.path}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: session, isLoading } = useQuery({
    queryKey: ["session", id],
    queryFn: () => api.session(id!),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  const { data: agents } = useQuery({
    queryKey: ["agents", id],
    queryFn: () => api.sessionAgents(id!),
    refetchInterval: 5_000,
    enabled: !!id,
  });

  if (!id) return null;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Zap className="mr-2 h-4 w-4 animate-pulse" />
        Loading session…
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Session not found.</p>
        <Link to="/" className="text-sm text-cyan-400 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const totalCost = agents?.reduce((sum, a) => sum + (a.cost_usd ?? 0), 0) ?? 0;
  const duration = session.completed_at
    ? new Date(session.completed_at).getTime() - new Date(session.created_at).getTime()
    : Date.now() - new Date(session.created_at).getTime();

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/60 bg-zinc-950/60 px-5 py-3 backdrop-blur">
        <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="truncate text-base font-semibold">
            {session.name || "Unnamed session"}
          </h1>
          <Badge
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider",
              statusColor(session.status)
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(session.status))} />
            {session.status}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-shrink-0">
          {session.chain && (
            <span className="flex items-center gap-1">
              <Hash className="h-3 w-3" />
              {session.chain}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {relativeTime(session.created_at)}
          </span>
        </div>
      </div>

      {/* Stat bar */}
      <div className="grid grid-cols-4 gap-3 border-b border-border/60 bg-zinc-950/40 px-5 py-3">
        <StatCard
          label="Agents"
          value={agents?.length ?? "—"}
          icon={<Bot className="h-4 w-4" />}
          accent="bg-purple-500/10 text-purple-400"
        />
        <StatCard
          label="Total cost"
          value={formatCost(totalCost)}
          icon={<DollarSign className="h-4 w-4" />}
          accent="bg-amber-500/10 text-amber-400"
        />
        <StatCard
          label="Duration"
          value={formatDuration(duration)}
          icon={<Clock className="h-4 w-4" />}
          accent="bg-cyan-500/10 text-cyan-400"
        />
        <StatCard
          label="Platform"
          value={session.platform || "—"}
          icon={<Layers className="h-4 w-4" />}
          accent="bg-blue-500/10 text-blue-400"
        />
      </div>

      {/* Tabbed content */}
      <div className="flex flex-1 overflow-hidden">
        <Tabs defaultValue="stream" className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-border/60 px-5 py-2">
            <TabsList>
              <TabsTrigger value="stream">
                <Zap className="mr-1.5 h-3.5 w-3.5" />
                Live Stream
              </TabsTrigger>
              <TabsTrigger value="agents">
                <Bot className="mr-1.5 h-3.5 w-3.5" />
                Agents
                {agents && (
                  <span className="ml-1.5 rounded-full bg-zinc-700 px-1.5 py-0 text-[10px]">
                    {agents.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="files">
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                Files
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="stream" className="flex flex-1 overflow-hidden mt-0">
            <EventStream sessionId={id} />
          </TabsContent>

          <TabsContent value="agents" className="flex-1 overflow-y-auto mt-0">
            <Card className="m-4 border-zinc-800 bg-zinc-900/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Agents
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <AgentList sessionId={id} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="files" className="flex-1 overflow-y-auto mt-0">
            <Card className="m-4 border-zinc-800 bg-zinc-900/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Files Touched
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <DiffView sessionId={id} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
