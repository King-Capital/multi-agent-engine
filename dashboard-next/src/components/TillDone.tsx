/**
 * TillDone — real-time till_done progress checklist.
 * Renders TillDoneState from SSE "tilldone" events with animated
 * checkmarks and a smooth progress bar.
 *
 * Uses shared SSE context — no duplicate connections.
 */

import * as React from "react";
import { CheckCircle, Circle, Loader2, Target } from "lucide-react";
import type { TillDoneState, TillDoneItem, LiveEvent } from "@/lib/types";
import { useSessionSSE } from "@/hooks/useSessionSSE";
import { cn } from "@/lib/utils";

// ─── Single item row ──────────────────────────────────────────────────────────

function TillDoneRow({ item, index }: { item: TillDoneItem; index: number }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2.5 transition-all duration-500",
        item.active && !item.completed && "bg-cyan-950/30 border border-cyan-900/40",
        item.completed && "opacity-60",
      )}
    >
      <div className="mt-0.5 shrink-0">
        {item.completed ? (
          <CheckCircle className="w-4 h-4 text-emerald-400" />
        ) : item.active ? (
          <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
        ) : (
          <Circle className="w-4 h-4 text-zinc-700" />
        )}
      </div>

      <p
        className={cn(
          "flex-1 text-sm leading-snug",
          item.completed && "line-through text-zinc-500",
          item.active && !item.completed && "text-zinc-100",
          !item.active && !item.completed && "text-zinc-500",
        )}
      >
        {item.description}
      </p>

      <span className="ml-auto text-[10px] text-zinc-700 shrink-0 mt-0.5">
        {index + 1}
      </span>
    </div>
  );
}

// ─── Static display (pass state directly) ────────────────────────────────────

export function TillDoneDisplay({ state }: { state: TillDoneState }) {
  const pct =
    state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-cyan-400 shrink-0" />
        <p className="flex-1 min-w-0 text-sm font-semibold text-zinc-100 leading-tight truncate">
          {state.title}
        </p>
        <span className="text-xs text-cyan-400 font-mono shrink-0">
          {state.completed}/{state.total}
        </span>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-zinc-600">
          <span>{pct}% complete</span>
          <span>{state.total - state.completed} remaining</span>
        </div>
      </div>

      {/* Item list */}
      <div className="space-y-0.5">
        {state.items.map((item, i) => (
          <TillDoneRow key={i} item={item} index={i} />
        ))}
      </div>

      {pct === 100 && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-emerald-900/40 bg-emerald-950/40 py-2 text-sm text-emerald-400 font-medium">
          <CheckCircle className="w-4 h-4" />
          All criteria met
        </div>
      )}
    </div>
  );
}

// ─── Live SSE version ─────────────────────────────────────────────────────────

interface TillDoneProps {
  sessionId: string;
  /** Optional initial state pre-loaded from historical events */
  initialState?: TillDoneState | null;
}

export function TillDone({ sessionId, initialState }: TillDoneProps) {
  const [state, setState] = React.useState<TillDoneState | null>(
    initialState ?? null,
  );

  // Use shared SSE context instead of opening a separate connection
  const { subscribe } = useSessionSSE();

  React.useEffect(() => {
    const unsub = subscribe((event: LiveEvent) => {
      if (event.event_type === "tilldone" && event.data?.tilldone) {
        setState(event.data.tilldone as TillDoneState);
      }
    });
    return unsub;
  }, [subscribe]);

  if (!state) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="text-center space-y-2">
          <Target className="w-8 h-8 mx-auto text-zinc-700" />
          <p className="text-sm text-zinc-600">Waiting for till_done criteria…</p>
        </div>
      </div>
    );
  }

  return <TillDoneDisplay state={state} />;
}
