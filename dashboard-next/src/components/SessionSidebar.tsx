/**
 * SessionSidebar — Mode 1 left panel.
 *
 * Contains:
 * - Header with MAE Dashboard + lightning icon
 * - Users dropdown (fetched from /api/users)
 * - Status filter pills (All, Active, Waiting, Paused, Done, Error)
 * - Sort dropdown (Newest, Oldest, Cost desc)
 * - Filtered + sorted session list
 *
 * Filter and sort state persisted in localStorage.
 */

import * as React from "react";
import { Zap } from "lucide-react";
import { apiFetch, api } from "@/lib/api";
import type { DBSession, DBUser } from "@/lib/types";
import { cn, formatCurrency, formatNumber, shortId, statusColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

// ─── Filter types ─────────────────────────────────────────────────────────────

type StatusFilter =
	| "all"
	| "active"
	| "waiting"
	| "paused"
	| "completed"
	| "error";
type SortMode = "newest" | "oldest" | "cost" | "tokens";

const STATUS_PILLS: {
	value: StatusFilter;
	label: string;
	activeClass: string;
	inactiveClass: string;
}[] = [
	{
		value: "all",
		label: "All",
		activeClass: "bg-zinc-600 text-zinc-100 ring-1 ring-zinc-500",
		inactiveClass: "bg-zinc-800/60 text-zinc-500 hover:text-zinc-300",
	},
	{
		value: "active",
		label: "Active",
		activeClass: "bg-green-500 text-white ring-1 ring-green-400",
		inactiveClass: "bg-green-500/15 text-green-400 hover:bg-green-500/25",
	},
	{
		value: "waiting",
		label: "Waiting",
		activeClass: "bg-yellow-500 text-white ring-1 ring-yellow-400",
		inactiveClass: "bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25",
	},
	{
		value: "paused",
		label: "Paused",
		activeClass: "bg-orange-500 text-white ring-1 ring-orange-400",
		inactiveClass: "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25",
	},
	{
		value: "completed",
		label: "Done",
		activeClass: "bg-blue-500 text-white ring-1 ring-blue-400",
		inactiveClass: "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25",
	},
	{
		value: "error",
		label: "Error",
		activeClass: "bg-red-500 text-white ring-1 ring-red-400",
		inactiveClass: "bg-red-500/15 text-red-400 hover:bg-red-500/25",
	},
];

// ─── localStorage helpers ─────────────────────────────────────────────────────

function loadFilters(): Set<StatusFilter> {
	try {
		const raw = localStorage.getItem("mae-status-filters");
		if (raw) {
			const parsed = JSON.parse(raw) as StatusFilter[];
			if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed);
		}
	} catch {}
	return new Set<StatusFilter>();
}

function saveFilters(filters: Set<StatusFilter>) {
	try {
		localStorage.setItem("mae-status-filters", JSON.stringify([...filters]));
	} catch {}
}

function loadSort(): SortMode {
	try {
		const v = localStorage.getItem("mae-sort") as SortMode | null;
		if (v && ["newest", "oldest", "cost", "tokens"].includes(v)) return v;
	} catch {}
	return "newest";
}

function saveSort(s: SortMode) {
	try {
		localStorage.setItem("mae-sort", s);
	} catch {}
}

function loadUser(): string {
	try {
		return localStorage.getItem("mae-user") ?? "";
	} catch {
		return "";
	}
}

function saveUser(u: string) {
	try {
		localStorage.setItem("mae-user", u);
	} catch {}
}

function loadSearch(): string {
	try {
		return localStorage.getItem("mae-session-search") ?? "";
	} catch {
		return "";
	}
}

function saveSearch(search: string) {
	try {
		localStorage.setItem("mae-session-search", search);
	} catch {}
}

// ─── Status matching ──────────────────────────────────────────────────────────

function matchesFilter(status: string, filters: Set<StatusFilter>): boolean {
	if (filters.size === 0 || filters.has("all")) return true;
	// Normalise completed/done
	const s = status.toLowerCase();
	if (s === "completed" || s === "done") return filters.has("completed");
	if (s === "failed") return filters.has("error");
	return filters.has(s as StatusFilter);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SessionSidebarProps {
	sessions: DBSession[];
	totalSessions?: number;
	selectedUser: string;
	onUserChange: (username: string) => void;
	selectedId?: string;
	onSelect: (id: string) => void;
	/** Double-click to open session detail view */
	onDoubleClick?: (id: string) => void;
	onLoadMore?: () => void;
	hasMore?: boolean;
	loading: boolean;
	error: string | null;
}

export function SessionSidebar({
	sessions,
	totalSessions,
	selectedUser,
	onUserChange,
	selectedId,
	onSelect,
	onDoubleClick,
	onLoadMore,
	hasMore,
	loading,
	error,
}: SessionSidebarProps) {
	const [users, setUsers] = React.useState<DBUser[]>([]);
	const [search, setSearch] = React.useState(() => loadSearch());
	const [filters, setFilters] = React.useState<Set<StatusFilter>>(() =>
		loadFilters(),
	);
	const [sort, setSort] = React.useState<SortMode>(() => loadSort());

	// Fetch users once
	React.useEffect(() => {
		apiFetch<DBUser[]>("/api/users")
			.then((u) => setUsers(u ?? []))
			.catch(() => {});
	}, []);

	// Fetch history for cost data (keyed by session ID)
	const [costMap, setCostMap] = React.useState<Map<string, { cost: number; agents: number; tokens: number }>>(new Map());
	React.useEffect(() => {
		const limit = Math.min(Math.max(sessions.length, 500), 5000);
		api.history(limit)
			.then((h) => {
				const m = new Map<string, { cost: number; agents: number; tokens: number }>();
				for (const e of h) m.set(e.id, { cost: e.total_cost, agents: e.agent_count, tokens: e.total_tokens ?? 0 });
				setCostMap(m);
			})
			.catch(() => {});
	}, [sessions]);

	// Filter toggle
	function toggleFilter(f: StatusFilter) {
		setFilters((prev) => {
			if (f === "all") {
				const next = new Set<StatusFilter>();
				saveFilters(next);
				return next;
			}
			const next = new Set(prev);
			next.delete("all");
			if (next.has(f)) {
				next.delete(f);
			} else {
				next.add(f);
			}
			saveFilters(next);
			return next;
		});
	}

	function handleSortChange(e: React.ChangeEvent<HTMLSelectElement>) {
		const v = e.target.value as SortMode;
		setSort(v);
		saveSort(v);
	}

	function handleUserChange(e: React.ChangeEvent<HTMLSelectElement>) {
		const v = e.target.value;
		onUserChange(v);
		saveUser(v);
	}

	function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
		const v = e.target.value;
		setSearch(v);
		saveSearch(v);
	}

	// Filter + sort sessions
	const visible = React.useMemo(() => {
		let list = sessions.filter((s) => matchesFilter(s.status, filters));

		const normalizedSearch = search.trim().toLowerCase();
		if (normalizedSearch) {
			list = list.filter((s) =>
				[
					s.name,
					s.id,
					s.chain ?? "",
					s.status,
					s.platform,
				]
					.join(" ")
					.toLowerCase()
					.includes(normalizedSearch),
			);
		}

		// Sort
		const sorted = [...list];
		switch (sort) {
			case "newest":
				sorted.sort(
					(a, b) =>
						new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
				);
				break;
			case "oldest":
				sorted.sort(
					(a, b) =>
						new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
				);
				break;
			case "cost":
				sorted.sort((a, b) => {
					const ca = costMap.get(a.id)?.cost ?? 0;
					const cb = costMap.get(b.id)?.cost ?? 0;
					return cb - ca;
				});
				break;
			case "tokens":
				sorted.sort((a, b) => {
					const ta = costMap.get(a.id)?.tokens ?? 0;
					const tb = costMap.get(b.id)?.tokens ?? 0;
					return tb - ta;
				});
				break;
		}

		return sorted;
	}, [sessions, filters, sort, costMap, search]);

	return (
		<div className="flex h-full w-full flex-col">
			{/* Header */}
			<div className="shrink-0 p-4 border-b border-white/5">
				<div className="flex items-center gap-3 mb-3">
					<div className="rounded-xl bg-cyan-400/10 p-2 text-cyan-300">
						<Zap size={22} />
					</div>
					<div>
						<h1 className="font-bold text-zinc-100">MAE Dashboard</h1>
						<p className="text-xs text-slate-500">Multi-Agent Orchestration</p>
					</div>
				</div>

				{/* Users dropdown */}
				<select
					value={selectedUser}
					onChange={handleUserChange}
					className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-zinc-300 focus:outline-none focus:border-cyan-500/50 mb-2"
				>
					<option value="">All Users</option>
					{users.length === 0 && <option disabled>No users available</option>}
					{users.map((u) => (
						<option key={u.username} value={u.username}>
							{u.display_name} ({u.role})
						</option>
					))}
				</select>

				{/* Status filter pills */}
				<div className="flex flex-wrap gap-1 gap-y-1.5 mb-2">
					{STATUS_PILLS.map((pill) => {
						const isActive =
							pill.value === "all"
								? filters.size === 0
								: filters.has(pill.value);
						return (
							<button
								key={pill.value}
								onClick={() => toggleFilter(pill.value)}
								className={cn(
									"text-[11px] px-1.5 py-0.5 rounded transition-all",
									isActive ? pill.activeClass : pill.inactiveClass,
								)}
							>
								{pill.label}
							</button>
						);
					})}
				</div>

				{/* Sort + text filter + count */}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<span className="text-xs text-zinc-600">Sort:</span>
						<select
							value={sort}
							onChange={handleSortChange}
							className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-zinc-400 focus:outline-none focus:border-cyan-500/50"
						>
							<option value="newest">Newest</option>
							<option value="oldest">Oldest</option>
							<option value="cost">Cost ↓</option>
							<option value="tokens">Tokens ↓</option>
						</select>
						<input
							value={search}
							onChange={handleSearchChange}
							placeholder="Filter…"
							className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-cyan-500/50 focus:outline-none"
						/>
					</div>
					<span className="text-xs text-zinc-600">
						{loading
							? "Refreshing…"
							: totalSessions != null
								? `${visible.length}/${sessions.length} shown of ${totalSessions}`
								: `${visible.length} shown`}
						{error && <span className="text-red-400 ml-1">· {error}</span>}
					</span>
				</div>
			</div>

			{/* Session list */}
			<ScrollArea className="flex-1 px-3 pb-3">
				{visible.length === 0 && (
					<div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-slate-500 mt-3">
						No sessions match filters.
					</div>
				)}
				<div className="space-y-2 pt-2">
					{visible.map((s) => (
						<button
							key={s.id}
							onClick={() => onSelect(s.id)}
							onDoubleClick={() => onDoubleClick?.(s.id)}
							className={cn(
								"w-full rounded-xl border p-3 text-left transition hover:bg-white/5",
								selectedId === s.id
									? "border-cyan-400/40 bg-cyan-400/10"
									: "border-white/10 bg-white/[0.02]",
							)}
						>
							<div className="truncate text-sm font-semibold text-zinc-200">
								{s.name}
							</div>
							<div className="mt-1 text-xs text-slate-500">
								{shortId(s.id)} · {new Date(s.created_at).toLocaleString()}
							</div>
							<div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden">
								<Badge className={cn(statusColor(s.status), "text-[10px]")} variant="outline">
									{s.status}
								</Badge>
								{s.chain && <Badge variant="secondary" className="max-w-[110px] truncate text-[10px]" title={s.chain}>{s.chain}</Badge>}
								{(() => {
									const info = costMap.get(s.id);
									if (!info) {
										return null;
									}
									return (
										<span className="inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-emerald-300" title={`${formatCurrency(info.cost)}${info.tokens > 0 ? ` · ${formatNumber(info.tokens)} tokens` : ""}`}>
											<span>{formatCurrency(info.cost)}</span>
											{info.tokens > 0 && <span className="text-cyan-300">{(info.tokens / 1000).toFixed(0)}K tok</span>}
										</span>
									);
								})()}
							</div>
						</button>
					))}
					{hasMore && (
						<button
							type="button"
							onClick={onLoadMore}
							disabled={loading}
							className="w-full rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
						>
							{loading ? "Loading…" : `Load more sessions (${sessions.length}${totalSessions != null ? `/${totalSessions}` : ""})`}
						</button>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
