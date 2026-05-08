/**
 * CostBreakdown — per-agent cost table + mini recharts bar chart.
 * Accepts LiveAgent[] from /api/pg/sessions/:id/agents.
 */

import * as React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { DollarSign, Hash, TrendingUp } from "lucide-react";
import type { LiveAgent } from "@/lib/types";
import { formatCurrency, formatNumber, formatDuration } from "@/lib/utils";

// ─── Chart tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: LiveAgent; value: number }>;
}) {
  if (!active || !payload?.length) return null;
  const agent = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="font-semibold text-zinc-100 mb-1">{agent.name}</p>
      <p className="text-cyan-400">{formatCurrency(agent.cost_usd)}</p>
      <p className="text-zinc-500">{formatNumber(agent.tokens_used)} tokens</p>
    </div>
  );
}

// ─── Table Row ────────────────────────────────────────────────────────────────

function AgentCostRow({
  agent,
  total,
  rank,
}: {
  agent: LiveAgent;
  total: number;
  rank: number;
}) {
  const pct = total > 0 ? (agent.cost_usd / total) * 100 : 0;
  const teamColor =
    agent.team_color && /^#[0-9a-f]{3,6}$/i.test(agent.team_color)
      ? agent.team_color
      : "#22d3ee";

  return (
    <tr className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 transition-colors">
      {/* Rank */}
      <td className="py-2.5 pl-4 pr-2 text-[11px] text-zinc-600 font-mono w-8">
        {rank}
      </td>

      {/* Agent name + role */}
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: teamColor }}
          />
          <span className="text-sm text-zinc-200 font-medium truncate max-w-36">
            {agent.name}
          </span>
          <span className="text-[9px] text-zinc-600 uppercase font-bold shrink-0">
            {agent.role}
          </span>
        </div>
        <p className="text-[10px] text-zinc-600 ml-4 truncate">{agent.team_name}</p>
      </td>

      {/* Cost */}
      <td className="py-2.5 pr-4 text-right">
        <span className="text-sm text-cyan-400 font-mono font-semibold">
          {formatCurrency(agent.cost_usd)}
        </span>
      </td>

      {/* Tokens */}
      <td className="py-2.5 pr-4 text-right text-xs text-zinc-400 font-mono">
        {formatNumber(agent.tokens_used)}
      </td>

      {/* Elapsed */}
      <td className="py-2.5 pr-4 text-right text-xs text-zinc-500 font-mono">
        {formatDuration(agent.elapsed_ms)}
      </td>

      {/* % bar */}
      <td className="py-2.5 pr-4 w-32">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, pct)}%`,
                backgroundColor: teamColor,
              }}
            />
          </div>
          <span className="text-[10px] text-zinc-600 w-9 text-right">
            {pct.toFixed(1)}%
          </span>
        </div>
      </td>
    </tr>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface CostBreakdownProps {
  agents: LiveAgent[];
}

export function CostBreakdown({ agents }: CostBreakdownProps) {
  const sorted = React.useMemo(
    () => [...agents].sort((a, b) => b.cost_usd - a.cost_usd),
    [agents],
  );

  const totalCost = React.useMemo(
    () => agents.reduce((s, a) => s + a.cost_usd, 0),
    [agents],
  );

  const totalTokens = React.useMemo(
    () => agents.reduce((s, a) => s + a.tokens_used, 0),
    [agents],
  );

  const chartData = sorted.slice(0, 8);

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-zinc-600 text-sm">
        No agent cost data
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard
          icon={<DollarSign className="w-4 h-4 text-cyan-400" />}
          label="Total Cost"
          value={formatCurrency(totalCost)}
          accent
        />
        <SummaryCard
          icon={<Hash className="w-4 h-4 text-violet-400" />}
          label="Total Tokens"
          value={formatNumber(totalTokens)}
        />
        <SummaryCard
          icon={<TrendingUp className="w-4 h-4 text-emerald-400" />}
          label="Agents"
          value={String(agents.length)}
        />
      </div>

      {/* Bar chart */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
        <p className="text-xs text-zinc-500 mb-3 font-medium">
          Cost per agent (top {chartData.length})
        </p>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart
            data={chartData}
            margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
          >
            <XAxis
              dataKey="name"
              tick={{ fontSize: 9, fill: "#71717a" }}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickFormatter={(v: string) =>
                v.length > 10 ? v.slice(0, 9) + "…" : v
              }
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#71717a" }}
              tickLine={false}
              axisLine={false}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tickFormatter={(v: any) => `$${Number(v).toFixed(2)}`}
              width={44}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
            />
            <Bar dataKey="cost_usd" radius={[3, 3, 0, 0]}>
              {chartData.map((agent) => (
                <Cell
                  key={agent.id}
                  fill={
                    agent.team_color &&
                    /^#[0-9a-f]{3,6}$/i.test(agent.team_color)
                      ? agent.team_color
                      : "#22d3ee"
                  }
                  fillOpacity={0.8}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-zinc-800 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-zinc-900 border-b border-zinc-800">
            <tr>
              <th className="py-2 pl-4 pr-2 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider w-8">
                #
              </th>
              <th className="py-2 pr-3 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider">
                Agent
              </th>
              <th className="py-2 pr-4 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider text-right">
                Cost
              </th>
              <th className="py-2 pr-4 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider text-right">
                Tokens
              </th>
              <th className="py-2 pr-4 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider text-right">
                Time
              </th>
              <th className="py-2 pr-4 text-[10px] text-zinc-600 font-semibold uppercase tracking-wider w-36">
                Share
              </th>
            </tr>
          </thead>
          <tbody className="bg-zinc-950">
            {sorted.map((agent, i) => (
              <AgentCostRow
                key={agent.id}
                agent={agent}
                total={totalCost}
                rank={i + 1}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummaryCard({
  icon,
  label,
  value,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="flex items-center gap-2 mb-1 text-xs text-zinc-500">
        {icon}
        {label}
      </div>
      <p
        className={`text-xl font-bold font-mono ${accent ? "text-cyan-400" : "text-zinc-100"}`}
      >
        {value}
      </p>
    </div>
  );
}
