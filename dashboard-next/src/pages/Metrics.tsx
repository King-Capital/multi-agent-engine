import { useQuery } from "@tanstack/react-query";
import { Gauge, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPieChart } from "@/components/charts/StatusPieChart";
import { api } from "@/lib/api";
import { formatCurrency, formatDuration, formatNumber } from "@/lib/utils";
import type { MetricEntry } from "@/lib/types";

/** Parse Prometheus text format into structured entries */
function parsePrometheus(text: string): MetricEntry[] {
  const entries: MetricEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(.+)$/
    );
    if (!match) continue;

    const [, name, labelStr, valStr] = match;
    const labels: Record<string, string> = {};
    if (labelStr) {
      for (const pair of labelStr.split(",")) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = pair
            .slice(eqIdx + 1)
            .trim()
            .replace(/^"|"$/g, "");
          labels[k] = v;
        }
      }
    }
    const value = parseFloat(valStr);
    if (!isNaN(value)) {
      entries.push({ name, labels, value });
    }
  }
  return entries;
}

function MetricCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Gauge className="h-4 w-4 text-cyan-400" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Metrics() {
  const {
    data: metrics,
    isLoading,
    error,
    dataUpdatedAt,
  } = useQuery<MetricEntry[]>({
    queryKey: ["metrics"],
    queryFn: async () => {
      const text = await api.metricsText();
      return parsePrometheus(text);
    },
    refetchInterval: 10_000,
  });

  function find(name: string, labels?: Record<string, string>): number {
    if (!metrics) return 0;
    return (
      metrics.find(
        (m) =>
          m.name === name &&
          (!labels ||
            Object.entries(labels).every(([k, v]) => m.labels[k] === v))
      )?.value ?? 0
    );
  }

  function findAll(name: string): MetricEntry[] {
    return metrics?.filter((m) => m.name === name) ?? [];
  }

  const sessionStatuses = findAll("mae_sessions_total").map((m) => ({
    name: m.labels.status ?? "unknown",
    value: m.value,
  }));

  const agentStatuses = findAll("mae_agents_total").map((m) => ({
    name: m.labels.status ?? "unknown",
    value: m.value,
  }));

  const totalSessions = sessionStatuses.reduce((s, e) => s + e.value, 0);
  const totalAgents = agentStatuses.reduce((s, e) => s + e.value, 0);
  const totalCost = find("mae_total_cost_usd");
  const totalEvents = find("mae_events_total");
  const uptime = find("mae_dashboard_uptime_seconds");

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <Card className="glass max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-destructive font-medium">
              Failed to load metrics
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Metrics</h1>
          <p className="text-muted-foreground text-sm">
            Prometheus metrics · auto-refresh every 10s
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw
            className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
          />
          {dataUpdatedAt
            ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}`
            : "Loading…"}
        </div>
      </div>

      {/* Gauge cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          title="Sessions"
          value={isLoading ? "—" : formatNumber(totalSessions)}
          subtitle={sessionStatuses
            .filter((s) => s.value > 0)
            .map((s) => `${s.name}: ${s.value}`)
            .join(", ")}
        />
        <MetricCard
          title="Agents"
          value={isLoading ? "—" : formatNumber(totalAgents)}
          subtitle={agentStatuses
            .filter((s) => s.value > 0)
            .map((s) => `${s.name}: ${s.value}`)
            .join(", ")}
        />
        <MetricCard
          title="Total Cost"
          value={isLoading ? "—" : formatCurrency(totalCost)}
        />
        <MetricCard
          title="Events"
          value={isLoading ? "—" : formatNumber(totalEvents)}
        />
        <MetricCard
          title="Uptime"
          value={isLoading ? "—" : formatDuration(uptime)}
        />
      </div>

      {/* Status distribution charts */}
      <div className="grid gap-6 grid-cols-1 md:grid-cols-2">
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">Sessions by Status</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[240px] flex items-center justify-center text-muted-foreground">
                Loading…
              </div>
            ) : (
              <StatusPieChart data={sessionStatuses} title="Sessions" />
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">Agents by Status</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[240px] flex items-center justify-center text-muted-foreground">
                Loading…
              </div>
            ) : (
              <StatusPieChart data={agentStatuses} title="Agents" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Raw metrics table */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">Raw Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-2 text-xs font-medium text-muted-foreground">
                    Metric
                  </th>
                  <th className="text-left p-2 text-xs font-medium text-muted-foreground">
                    Labels
                  </th>
                  <th className="text-right p-2 text-xs font-medium text-muted-foreground">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {(metrics ?? []).map((m, i) => (
                  <tr
                    key={`${m.name}-${i}`}
                    className="border-b border-border/30"
                  >
                    <td className="p-2 font-mono text-xs">{m.name}</td>
                    <td className="p-2 text-muted-foreground text-xs">
                      {Object.entries(m.labels)
                        .map(([k, v]) => `${k}="${v}"`)
                        .join(", ") || "—"}
                    </td>
                    <td className="p-2 text-right font-mono text-xs tabular-nums">
                      {m.value % 1 === 0 ? m.value : m.value.toFixed(6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
