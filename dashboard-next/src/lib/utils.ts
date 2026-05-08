import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value = 0) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

export function formatNumber(value = 0) {
  return new Intl.NumberFormat().format(value);
}

/**
 * Format a duration given in milliseconds.
 * Use `formatDurationSec` for values already in seconds.
 */
export function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return formatDurationSec(seconds);
}

/**
 * Format a duration given in seconds.
 */
export function formatDurationSec(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * @deprecated Use `formatDurationMs` or `formatDurationSec` with explicit units.
 * Kept for backward compat — treats values as milliseconds.
 */
export function formatDuration(ms?: number) {
  return formatDurationMs(Math.max(0, ms ?? 0));
}

export function shortId(id?: string) {
  return id ? id.slice(0, 8) : "—";
}

export function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const abs = Math.abs(diff);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ago`;
  return `${Math.floor(abs / 86_400_000)}d ago`;
}

// ─── Consolidated status styling ──────────────────────────────────────────────

/**
 * Canonical status → CSS class mapping used by badges throughout the app.
 * Combines the former `statusClass` (App.tsx, SessionTabs.tsx) and `statusColor` variants.
 */
export function statusColor(status: string): string {
  switch (status) {
    case "active":
    case "running":
      return "text-cyan-400 bg-cyan-400/10 border-cyan-400/30";
    case "completed":
    case "done":
      return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
    case "error":
    case "failed":
      return "text-red-400 bg-red-400/10 border-red-400/30";
    case "waiting":
    case "paused":
    case "blocked":
      return "text-amber-400 bg-amber-400/10 border-amber-400/30";
    case "cancelled":
      return "text-zinc-400 bg-zinc-400/10 border-zinc-400/30";
    default:
      return "text-zinc-400 bg-zinc-400/10 border-zinc-400/30";
  }
}

export function statusDot(status: string): string {
  switch (status) {
    case "active":
    case "running":
      return "bg-cyan-400";
    case "completed":
    case "done":
      return "bg-emerald-400";
    case "error":
    case "failed":
      return "bg-red-400";
    case "waiting":
    case "paused":
    case "blocked":
      return "bg-amber-400";
    default:
      return "bg-zinc-500";
  }
}

/** Clamp and round a cost to a readable string */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return "<$0.001";
  return formatCurrency(usd);
}


// ─── Agent display colors ─────────────────────────────────────────────────────

/**
 * Agent display color. Prefers the engine's team_color when set and readable.
 * Falls back to role-based palette for missing or low-contrast colors.
 */
export function agentColor(role?: string, teamColor?: string): string {
  // Use team_color if it's set and not one of the known low-contrast cyans
  if (teamColor && /^#[0-9a-f]{3,8}$/i.test(teamColor)) {
    const LOW_CONTRAST = new Set([
      "#22d3ee", "#36f9f6", "#00d4ff", "#00b4d8", "#0090b0", "#94a3b8",
    ]);
    if (!LOW_CONTRAST.has(teamColor.toLowerCase())) return teamColor;
  }
  // Role-based fallback
  switch (role) {
    case "orchestrator": return "#a78bfa"; // violet
    case "lead":         return "#60a5fa"; // blue
    default:             return "#34d399"; // emerald
  }
}
