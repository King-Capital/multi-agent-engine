import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, Clock, Filter } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatCurrency, formatDuration } from "@/lib/utils";
import type { HistoryEntry, SessionStatus } from "@/lib/types";

type SortKey =
  | "name"
  | "chain"
  | "status"
  | "created_at"
  | "duration_secs"
  | "agent_count"
  | "total_cost";
type SortDir = "asc" | "desc";

const STATUS_FILTERS: Array<{ label: string; value: SessionStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Completed", value: "completed" },
  { label: "Error", value: "error" },
  { label: "Failed", value: "failed" },
];

function statusColor(status: string): string {
  switch (status) {
    case "active":
    case "running":
      return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
    case "completed":
    case "done":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "failed":
    case "error":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    case "cancelled":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

interface HistoryProps {
  /** Optional callback when user clicks a session row */
  onSelectSession?: (id: string) => void;
}

export default function History({ onSelectSession }: HistoryProps) {
  const [limit, setLimit] = useState(50);
  const [statusFilter, setStatusFilter] = useState<SessionStatus | "all">(
    "all"
  );
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading, error } = useQuery<HistoryEntry[]>({
    queryKey: ["history", limit],
    queryFn: () => api.history(limit),
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows =
      statusFilter === "all"
        ? data
        : data.filter((h) => h.status === statusFilter);

    rows = [...rows].sort((a, b) => {
      let av: string | number = a[sortKey] ?? "";
      let bv: string | number = b[sortKey] ?? "";
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      av = String(av);
      bv = String(bv);
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return rows;
  }, [data, statusFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    return (
      <button
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => toggleSort(field)}
      >
        {label}
        <ArrowUpDown
          className={`h-3 w-3 ${
            sortKey === field ? "text-cyan-400" : "opacity-40"
          }`}
        />
      </button>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <Card className="glass max-w-md">
          <CardContent className="p-6 text-center">
            <p className="text-destructive font-medium">
              Failed to load history
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Session History
          </h1>
          <p className="text-muted-foreground text-sm">
            {filtered.length} session{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f.value}
                variant={statusFilter === f.value ? "default" : "ghost"}
                size="sm"
                onClick={() => setStatusFilter(f.value)}
                className="text-xs h-7"
              >
                {f.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 50)}
              className="w-20 h-7 text-xs"
            />
          </div>
        </div>
      </div>

      <Card className="glass overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left p-3">
                  <SortHeader label="Name" field="name" />
                </th>
                <th className="text-left p-3">
                  <SortHeader label="Chain" field="chain" />
                </th>
                <th className="text-left p-3">
                  <SortHeader label="Status" field="status" />
                </th>
                <th className="text-left p-3">
                  <SortHeader label="Created" field="created_at" />
                </th>
                <th className="text-right p-3">
                  <SortHeader label="Duration" field="duration_secs" />
                </th>
                <th className="text-right p-3">
                  <SortHeader label="Agents" field="agent_count" />
                </th>
                <th className="text-right p-3">
                  <SortHeader label="Cost" field="total_cost" />
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="p-8 text-center text-muted-foreground"
                  >
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="p-8 text-center text-muted-foreground"
                  >
                    No sessions found
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border/50 hover:bg-accent/30 cursor-pointer transition-colors"
                    onClick={() => onSelectSession?.(row.id)}
                  >
                    <td className="p-3 font-medium truncate max-w-[200px]">
                      {row.name}
                    </td>
                    <td className="p-3 text-muted-foreground truncate max-w-[150px]">
                      {row.chain ?? "—"}
                    </td>
                    <td className="p-3">
                      <Badge className={statusColor(row.status)}>
                        {row.status}
                      </Badge>
                    </td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap">
                      {new Date(row.created_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="p-3 text-right text-muted-foreground tabular-nums">
                      {formatDuration(row.duration_secs)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {row.agent_count}
                    </td>
                    <td className="p-3 text-right font-mono text-xs tabular-nums">
                      {formatCurrency(row.total_cost)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
