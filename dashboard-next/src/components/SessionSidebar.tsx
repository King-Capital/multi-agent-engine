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
import { apiFetch } from "@/lib/api";
import type { DBSession, DBUser } from "@/lib/types";
import { cn, shortId, statusColor } from "@/lib/utils";
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
type SortMode = "newest" | "oldest" | "cost";

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
		if (v && ["newest", "oldest", "cost"].includes(v)) return v;
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
	selectedId?: string;
	onSelect: (id: string) => void;
	/** Double-click to open session detail view */
	onDoubleClick?: (id: string) => void;
	loading: boolean;
	error: string | null;
}

export function SessionSidebar({
	sessions,
	selectedId,
	onSelect,
	onDoubleClick,
	loading,
	error,
}: SessionSidebarProps) {
	const [users, setUsers] = React.useState<DBUser[]>([]);
	const [selectedUser, setSelectedUser] = React.useState(() => loadUser());
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
		setSelectedUser(v);
		saveUser(v);
	}

	// Filter + sort sessions
	const visible = React.useMemo(() => {
		let list = sessions.filter((s) => matchesFilter(s.status, filters));

		// User filter
		if (selectedUser) {
			list = list.filter((s) => {
				// Match by user_id or check if name contains username
				const u = users.find((u) => u.username === selectedUser);
				if (u && s.user_id != null) return s.user_id === u.id;
				return true; // No user_id set — show anyway
			});
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
				// We don't have cost on DBSession directly, so sort by updated_at as proxy
				// (sessions with more activity tend to be costlier — good enough for now)
				sorted.sort(
					(a, b) =>
						new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
				);
				break;
		}

		return sorted;
	}, [sessions, filters, sort, selectedUser, users]);

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

				{/* Sort + count */}
				<div className="flex flex-wrap items-center justify-between gap-y-1">
					<div className="flex items-center gap-1.5 min-w-0">
						<span className="text-xs text-zinc-600">Sort:</span>
						<select
							value={sort}
							onChange={handleSortChange}
							className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-zinc-400 focus:outline-none focus:border-cyan-500/50"
						>
							<option value="newest">Newest</option>
							<option value="oldest">Oldest</option>
							<option value="cost">Cost ↓</option>
						</select>
					</div>
					<span className="text-xs text-zinc-600">
						{loading ? "Refreshing…" : `${visible.length} sessions`}
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
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate text-sm font-semibold text-zinc-200">
										{s.name}
									</div>
									<div className="mt-1 text-xs text-slate-500">
										{shortId(s.id)} · {new Date(s.created_at).toLocaleString()}
									</div>
								</div>
								<Badge className={statusColor(s.status)} variant="outline">
									{s.status}
								</Badge>
							</div>
							<div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
								{s.chain && <Badge variant="secondary">{s.chain}</Badge>}
								<span>{s.platform}</span>
							</div>
						</button>
					))}
				</div>
			</ScrollArea>
		</div>
	);
}
