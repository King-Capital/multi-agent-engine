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

export function formatDuration(msOrSeconds?: number) {
  const val = Math.max(0, msOrSeconds ?? 0);
  // Heuristic: if val > 10000, treat as milliseconds; else as seconds
  const seconds = val > 10_000 ? Math.round(val / 1000) : Math.round(val);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
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

export function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "text-cyan-400 bg-cyan-400/10 border-cyan-400/30";
    case "completed":
      return "text-emerald-400 bg-emerald-400/10 border-emerald-400/30";
    case "error":
    case "failed":
      return "text-red-400 bg-red-400/10 border-red-400/30";
    case "waiting":
    case "paused":
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
      return "bg-cyan-400";
    case "completed":
      return "bg-emerald-400";
    case "error":
    case "failed":
      return "bg-red-400";
    case "waiting":
    case "paused":
      return "bg-amber-400";
    default:
      return "bg-zinc-500";
  }
}

/** Clamp and round a cost to a readable string */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `<$0.001`;
  return formatCurrency(usd);
}
