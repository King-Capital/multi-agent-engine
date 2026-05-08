/**
 * DashboardLayout — shell with left sidebar (SessionList) and top header.
 * Uses react-router-dom <Outlet /> for page content.
 */

import { Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Wifi, WifiOff, Zap } from "lucide-react";
import { api } from "@/lib/api";
import SessionList from "@/components/SessionList";
import { cn } from "@/lib/utils";

// ─── Health indicator ─────────────────────────────────────────────────────────

function HealthIndicator() {
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    refetchInterval: 30_000,
    retry: false,
  });

  const ok = !isError && data?.status === "ok";

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "border-red-500/40 bg-red-500/10 text-red-400"
      )}
      title={
        data
          ? `API ${data.status}${data.db ? ` · DB ${data.db}` : ""}${data.uptime_seconds ? ` · up ${Math.round(data.uptime_seconds / 60)}m` : ""}`
          : "Checking API health…"
      }
    >
      {ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {ok ? "Connected" : isError ? "Offline" : "…"}
    </span>
  );
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function DashboardLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground bg-grid">
      {/* ── Left sidebar ── */}
      <aside className="flex w-72 flex-shrink-0 flex-col border-r border-border/60 bg-zinc-950/80 backdrop-blur">
        {/* Logo bar */}
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-cyan-500/20 ring-1 ring-cyan-500/40">
            <Zap className="h-4 w-4 text-cyan-400" />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-sm font-bold tracking-tight text-foreground">MAE</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
              Multi-Agent Engine
            </span>
          </div>
        </div>

        {/* Session list fills remaining sidebar space */}
        <div className="flex-1 overflow-hidden">
          <SessionList />
        </div>
      </aside>

      {/* ── Main content area ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top header */}
        <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border/60 bg-zinc-950/70 px-5 backdrop-blur">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            <span>Real-time dashboard</span>
          </div>
          <HealthIndicator />
        </header>

        {/* Router outlet */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
