/**
 * SessionList — sidebar session list.
 * Polls /api/pg/sessions every 5s via React Query.
 * Also subscribes to /api/stream SSE for instant session_start/session_end updates.
 */

import { useEffect, useCallback } from "react";
import { NavLink } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Hash, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useEventStream } from "@/hooks/useEventStream";
import type { DBSession, LiveEvent } from "@/lib/types";
import { cn, relativeTime, statusColor, statusDot } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider",
        statusColor(status)
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(status))} />
      {status}
    </span>
  );
}

// ─── Session row ──────────────────────────────────────────────────────────────

function SessionRow({ session }: { session: DBSession }) {
  return (
    <NavLink
      to={`/session/${session.id}`}
      className={({ isActive }) =>
        cn(
          "group flex flex-col gap-1 rounded-lg px-3 py-2.5 transition-colors",
          isActive
            ? "bg-cyan-500/10 ring-1 ring-cyan-500/30"
            : "hover:bg-zinc-800/60"
        )
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {session.name || "Unnamed session"}
        </span>
        <StatusBadge status={session.status} />
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {session.chain && (
          <span className="flex items-center gap-1 truncate">
            <Hash className="h-3 w-3 flex-shrink-0" />
            {session.chain}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 flex-shrink-0">
          <Clock className="h-3 w-3" />
          {relativeTime(session.created_at)}
        </span>
      </div>
    </NavLink>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SessionList() {
  const queryClient = useQueryClient();

  // Poll for sessions list
  const { data: sessions, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  // SSE: inject/update sessions in real-time without waiting for next poll
  const handleGlobalEvent = useCallback(
    (evt: LiveEvent) => {
      if (evt.event_type === "session_start") {
        queryClient.setQueryData<DBSession[]>(["sessions"], (prev = []) => {
          if (prev.find((s) => s.id === evt.session_id)) return prev;
          const newSession: DBSession = {
            id: evt.session_id,
            name: evt.data?.session_name ?? evt.session_id,
            platform: "sse",
            status: "active",
            created_at: evt.timestamp ?? new Date().toISOString(),
            updated_at: evt.timestamp ?? new Date().toISOString(),
            team: evt.data?.team_name ?? null,
            chain: evt.data?.team_config ?? null,
          };
          return [newSession, ...prev];
        });
      }

      if (evt.event_type === "session_end") {
        queryClient.setQueryData<DBSession[]>(["sessions"], (prev = []) =>
          prev.map((s) =>
            s.id === evt.session_id ? { ...s, status: "completed" } : s
          )
        );
      }
    },
    [queryClient]
  );

  const { connected } = useEventStream({
    sessionId: "*",
    onEvent: handleGlobalEvent,
  });

  // Refresh on reconnect
  useEffect(() => {
    if (connected) {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [connected, queryClient]);

  // Sort: active first, then by created_at desc
  const sorted = sessions
    ? [...sessions].sort((a, b) => {
        if (a.status === "active" && b.status !== "active") return -1;
        if (b.status === "active" && a.status !== "active") return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
    : [];

  const activeSessions = sorted.filter((s) => s.status === "active");
  const otherSessions = sorted.filter((s) => s.status !== "active");

  return (
    <div className="flex h-full flex-col">
      {/* Section header */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Sessions
        </span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1 text-[10px]",
              connected ? "text-cyan-400" : "text-zinc-600"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-cyan-400 animate-pulse" : "bg-zinc-600"
              )}
            />
            {connected ? "Live" : "Offline"}
          </span>
          <button
            onClick={() => void refetch()}
            className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-zinc-800 transition-colors"
            title="Refresh sessions"
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1 px-2 pb-2">
        {/* Loading skeleton */}
        {isLoading && (
          <div className="flex flex-col gap-1.5 px-2 pt-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-zinc-800/40 animate-pulse" />
            ))}
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="px-3 py-4 text-xs text-red-400">
            Failed to load sessions.{" "}
            <button className="underline hover:no-underline" onClick={() => void refetch()}>
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && sorted.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No sessions yet.
          </div>
        )}

        {/* Active sessions */}
        {activeSessions.length > 0 && (
          <div className="mb-1">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-cyan-500/70">
              Active · {activeSessions.length}
            </div>
            <div className="flex flex-col gap-0.5">
              {activeSessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          </div>
        )}

        {/* Historical sessions */}
        {otherSessions.length > 0 && (
          <div>
            {activeSessions.length > 0 && (
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Recent
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              {otherSessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
