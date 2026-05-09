/**
 * AgentDetail — slide-in panel showing full info for a selected agent node.
 * Shows: name, role, model, team, status, cost, tokens, persona path,
 * filtered event log, and files touched via tool_call events.
 */

import * as React from "react";
import {
  Cpu,
  Layers,
  DollarSign,
  Hash,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  X,
  User,
} from "lucide-react";
import type { LiveAgent, DBEvent, LiveEvent } from "@/lib/types";
import { formatCurrency, formatNumber, formatDurationMs, shortId } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { cls: string; Icon: React.ElementType }> = {
    running: { cls: "bg-cyan-500/20 text-cyan-400 border-cyan-800", Icon: Clock },
    done: { cls: "bg-emerald-500/20 text-emerald-400 border-emerald-800", Icon: CheckCircle },
    error: { cls: "bg-red-500/20 text-red-400 border-red-800", Icon: XCircle },
    blocked: { cls: "bg-amber-500/20 text-amber-400 border-amber-800", Icon: AlertTriangle },
    idle: { cls: "bg-zinc-700/40 text-zinc-400 border-zinc-700", Icon: Clock },
  };
  const { cls, Icon } = variants[status] ?? variants.idle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}

const ROLE_COLOR: Record<string, string> = {
  orchestrator: "bg-violet-500/20 text-violet-300 border-violet-800",
  lead: "bg-blue-500/20 text-blue-300 border-blue-800",
  worker: "bg-zinc-700/40 text-zinc-300 border-zinc-700",
};

const EVENT_COLORS: Record<string, string> = {
  agent_spawn: "text-cyan-400",
  agent_done: "text-emerald-400",
  message: "text-blue-400",
  tool_call: "text-amber-400",
  cost_update: "text-purple-400",
  error: "text-red-400",
  tilldone: "text-teal-400",
  domain_block: "text-orange-400",
  self_heal: "text-yellow-400",
};

// ─── Normalise a DB or Live event into a uniform shape ────────────────────────

interface NormEvent {
  type: string;
  agentId: string;
  ts: string | undefined;
  summary: string;
  filePath?: string;
  cost?: number;
  tokens?: number;
}

function normalise(event: DBEvent | LiveEvent): NormEvent {
  // DBEvent has .payload wrapping the LiveEvent
  if ("payload" in event && event.payload && typeof event.payload === "object" && "event_type" in event.payload) {
    const live = event.payload as LiveEvent;
    return normLive(live, (event as DBEvent).created_at);
  }
  return normLive(event as LiveEvent, undefined);
}

function normLive(event: LiveEvent, fallbackTs?: string): NormEvent {
  const d = event.data ?? {};
  let summary = "";
  if (d.content) summary = String(d.content).slice(0, 100);
  else if (d.error_msg) summary = String(d.error_msg).slice(0, 100);
  else if (d.tool) summary = `${d.tool}${d.file_path ? ` → ${d.file_path}` : ""}`;
  else if (d.agent_name) summary = String(d.agent_name);
  else if (event.cost_usd) summary = `$${event.cost_usd.toFixed(4)}`;

  return {
    type: event.event_type,
    agentId: event.agent_id,
    ts: event.timestamp ?? fallbackTs,
    summary,
    filePath: d.file_path ? String(d.file_path) : undefined,
    cost: event.cost_usd,
    tokens: event.tokens_used,
  };
}

// ─── Event Row ────────────────────────────────────────────────────────────────

function EventRow({ norm }: { norm: NormEvent }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50 last:border-0">
      <span className={cn("text-[10px] font-mono mt-0.5 shrink-0 w-24 truncate", EVENT_COLORS[norm.type] ?? "text-zinc-500")}>
        {norm.type}
      </span>
      <div className="flex-1 min-w-0">
        {norm.summary && (
          <p className="text-xs text-zinc-400 truncate">{norm.summary}</p>
        )}
      </div>
      {norm.ts && (
        <span className="text-[10px] text-zinc-600 shrink-0">
          {new Date(norm.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
    </div>
  );
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────

function InfoRow({
  icon,
  label,
  value,
  mono = false,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="flex items-center gap-1 text-[10px] text-zinc-600 uppercase tracking-wider font-medium">
        {icon}
        {label}
      </p>
      <div
        className={cn(
          "text-xs truncate",
          accent ? "text-cyan-400 font-semibold font-mono" : mono ? "font-mono text-zinc-300" : "text-zinc-200",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface AgentDetailProps {
  agent: LiveAgent;
  events?: (DBEvent | LiveEvent)[];
  onClose?: () => void;
}

export function AgentDetail({ agent, events = [], onClose }: AgentDetailProps) {
  const teamColor = /^#[0-9a-f]{3,6}$/i.test(agent.team_color ?? "")
    ? agent.team_color
    : "#22d3ee";

  // Normalise and filter to this agent's events
  const agentEvents = React.useMemo(() => {
    const normed: NormEvent[] = [];
    for (const e of events) {
      const n = normalise(e);
      if (n.agentId === agent.id) normed.push(n);
    }
    return normed;
  }, [events, agent.id]);

  // Files touched from tool_call events
  const touchedFiles = React.useMemo(() => {
    const files = new Set<string>();
    for (const n of agentEvents) {
      if (n.type === "tool_call" && n.filePath) files.add(n.filePath);
    }
    return Array.from(files);
  }, [agentEvents]);

  const contextPct =
    agent.context_max > 0
      ? Math.round((agent.context_tokens / agent.context_max) * 100)
      : 0;

  return (
    <div className="flex flex-col h-full rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
      {/* Header */}
      <div
        className="px-4 py-3 border-b border-zinc-800 flex items-start justify-between gap-2"
        style={{ borderTopColor: teamColor, borderTopWidth: 3 }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">{agent.name}</h3>
            <Badge
              className={cn("text-[10px] font-bold border", ROLE_COLOR[agent.role] ?? ROLE_COLOR.worker)}
            >
              {agent.role}
            </Badge>
          </div>
          <p className="text-[11px] text-zinc-500 mt-0.5 font-mono">{shortId(agent.id)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={agent.status} />
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-500 hover:text-zinc-100"
              onClick={onClose}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3">
            <InfoRow icon={<Cpu className="w-3.5 h-3.5" />} label="Model" value={agent.model} mono />
            <InfoRow
              icon={<Layers className="w-3.5 h-3.5" />}
              label="Team"
              value={
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: teamColor }} />
                  {agent.team_name}
                </span>
              }
            />
            <InfoRow icon={<DollarSign className="w-3.5 h-3.5" />} label="Cost" value={formatCurrency(agent.cost_usd)} accent />
            <InfoRow icon={<Hash className="w-3.5 h-3.5" />} label="Tokens" value={formatNumber(agent.tokens_used)} />
            <InfoRow icon={<Clock className="w-3.5 h-3.5" />} label="Elapsed" value={formatDurationMs(agent.elapsed_ms)} />
            {agent.parent_id && (
              <InfoRow icon={<User className="w-3.5 h-3.5" />} label="Parent" value={shortId(agent.parent_id)} mono />
            )}
          </div>

          {/* Context window usage */}
          {agent.context_max > 0 && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-zinc-500">
                <span>Context</span>
                <span>
                  {formatNumber(agent.context_tokens)} / {formatNumber(agent.context_max)} ({contextPct}%)
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(100, contextPct)}%`,
                    backgroundColor:
                      contextPct > 95 ? "#ef4444" : contextPct > 80 ? "#f59e0b" : teamColor,
                  }}
                />
              </div>
            </div>
          )}

          {/* Persona path */}
          {agent.persona_path && (
            <div>
              <p className="text-[10px] text-zinc-600 mb-1 uppercase tracking-wider font-medium">Persona</p>
              <div className="flex items-center gap-1.5 bg-zinc-950 rounded px-2 py-1.5 border border-zinc-800">
                <FileText className="w-3 h-3 text-zinc-500 shrink-0" />
                <span className="text-[11px] text-zinc-400 font-mono break-all">{agent.persona_path}</span>
              </div>
            </div>
          )}

          {/* Files touched */}
          {touchedFiles.length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-600 mb-1.5 uppercase tracking-wider font-medium">
                Files touched ({touchedFiles.length})
              </p>
              <div className="space-y-1">
                {touchedFiles.map((f) => (
                  <div
                    key={f}
                    className="flex items-center gap-1.5 text-[11px] text-zinc-400 font-mono bg-zinc-950 rounded px-2 py-1 border border-zinc-800/50"
                  >
                    <FileText className="w-3 h-3 text-zinc-600 shrink-0" />
                    <span className="truncate">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Event log */}
          <div>
            <p className="text-[10px] text-zinc-600 mb-1.5 uppercase tracking-wider font-medium">
              Events ({agentEvents.length})
            </p>
            {agentEvents.length === 0 ? (
              <p className="text-xs text-zinc-600 italic">No events recorded</p>
            ) : (
              <div className="bg-zinc-950 rounded border border-zinc-800 px-3 py-1">
                {agentEvents.slice(-60).map((n, i) => (
                  <EventRow key={i} norm={n} />
                ))}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
