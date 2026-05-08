import { useQuery } from "@tanstack/react-query";
import { Activity, Users, DollarSign, Zap, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CostAreaChart } from "@/components/charts/CostAreaChart";
import { CostBarChart } from "@/components/charts/CostBarChart";
import { api } from "@/lib/api";
import { formatCurrency, formatNumber, formatDuration } from "@/lib/utils";
import type { StatsResponse, HealthResponse } from "@/lib/types";

function StatCard({
  title,
  value,
  icon: Icon,
  description,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  description?: string;
}) {
  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-cyan-400" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const {
    data: stats,
    isLoading,
    error,
  } = useQuery<StatsResponse>({
    queryKey: ["stats"],
    queryFn: () => api.stats(),
    refetchInterval: 30_000,
  });

  const { data: health } = useQuery<HealthResponse>({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 10_000,
  });

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="glass max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-destructive font-medium">Failed to load stats</p>
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
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground text-sm">
            Multi-Agent Engine Dashboard
          </p>
        </div>
        {health && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Uptime: {formatDuration(health.uptime_seconds)}</span>
            <span
              className={`ml-2 h-2 w-2 rounded-full ${
                health.status === "ok" ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Sessions"
          value={isLoading ? "—" : formatNumber(stats?.total_sessions)}
          icon={Activity}
        />
        <StatCard
          title="Total Agents"
          value={isLoading ? "—" : formatNumber(stats?.total_agents)}
          icon={Users}
        />
        <StatCard
          title="Total Cost"
          value={isLoading ? "—" : formatCurrency(stats?.total_cost)}
          icon={DollarSign}
        />
        <StatCard
          title="Total Events"
          value={isLoading ? "—" : formatNumber(stats?.total_events)}
          icon={Zap}
        />
      </div>

      {/* Charts */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        {/* Cost per Day — spans 2 cols */}
        <Card className="glass lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Cost per Day</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                Loading…
              </div>
            ) : (
              <CostAreaChart data={stats?.cost_per_day ?? []} />
            )}
          </CardContent>
        </Card>

        {/* Top Chains by Cost */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">Top Chains by Cost</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[260px] flex items-center justify-center text-muted-foreground">
                Loading…
              </div>
            ) : (
              <CostBarChart data={stats?.top_chains ?? []} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
