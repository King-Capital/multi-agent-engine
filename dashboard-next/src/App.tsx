/**
 * App — two-mode layout with resizable panels and React Router.
 *
 * Mode 1 (SessionListPage): path /
 *   Left panel: SessionSidebar (users, filters, sort, session list)
 *   Right panel: Selected session tabs OR "Select a session" placeholder
 *
 * Mode 2 (SessionDetailPage): path /session/:id
 *   Left panel: AgentTreePanel (compact vertical agent hierarchy)
 *   Right panel: SessionTabs (stream, agents, till-done, files, cost, replay)
 */

import React, { useEffect, useState, useCallback } from "react";
import {
	BrowserRouter,
	Routes,
	Route,
	useNavigate,
	useParams,
} from "react-router-dom";
import {
	Activity,
	CircleDollarSign,
	HeartPulse,
	Users,
	Zap,
} from "lucide-react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { loadCurrentUser, logout } from "@/lib/auth";
import type { DBSession, DBUser } from "@/lib/types";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { usePolling } from "@/hooks/usePolling";
import { SessionSSEProvider } from "@/hooks/useSessionSSE";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ResizablePanel } from "@/components/ResizablePanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { AgentTreePanel } from "@/components/AgentTreePanel";
import { SessionTabs } from "@/components/SessionTabs";
import { LoginPage } from "@/components/LoginPage";
import { AdminTokenPanel } from "@/components/AdminTokenPanel";

// ─── Stats panel (shown when no session selected) ────────────────────────────

function StatsPanel({ data }: { data?: Awaited<ReturnType<typeof api.stats>> }) {
	const { data: fallbackData, loading, error } = usePolling(
		(signal) => api.stats(signal),
		15_000,
		[],
	);
	const stats = data ?? fallbackData;
	if (loading && !stats)
		return (
			<Card className="glass">
				<CardContent className="p-5 text-sm text-slate-400">
					Loading stats...
				</CardContent>
			</Card>
		);
	if (error || !stats)
		return (
			<Card className="glass">
				<CardContent className="p-5 text-sm text-red-300">
					Stats unavailable: {error}
				</CardContent>
			</Card>
		);

	return (
		<div className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{(
					[
						["Sessions", formatNumber(stats.total_sessions), Activity],
						["Agents", formatNumber(stats.total_agents), Users],
						["Total Cost", formatCurrency(stats.total_cost), CircleDollarSign],
						["Events", formatNumber(stats.total_events), Zap],
					] as const
				).map(([label, value, Icon]) => (
					<Card key={String(label)} className="glass">
						<CardContent className="flex items-center justify-between p-4">
							<div>
								<p className="text-xs uppercase tracking-wide text-slate-500">
									{String(label)}
								</p>
								<p className="mt-1 text-2xl font-bold">{String(value)}</p>
							</div>
							{React.createElement(Icon as typeof Activity, {
								className: "text-cyan-300",
							})}
						</CardContent>
					</Card>
				))}
			</div>

			<div className="grid gap-4 xl:grid-cols-2">
				<Card className="glass">
					<CardHeader>
						<CardTitle>Cost per day</CardTitle>
						<CardDescription>Last 30 days · all sessions</CardDescription>
					</CardHeader>
					<CardContent className="h-64">
						<ResponsiveContainer>
							<AreaChart data={stats.cost_per_day}>
								<defs>
									<linearGradient id="cost" x1="0" y1="0" x2="0" y2="1">
										<stop offset="5%" stopColor="#22d3ee" stopOpacity={0.5} />
										<stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
									</linearGradient>
								</defs>
								<CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
								<XAxis dataKey="day" stroke="#64748b" fontSize={12} />
								<YAxis stroke="#64748b" fontSize={12} />
								<Tooltip
									contentStyle={{
										background: "#020617",
										border: "1px solid #334155",
									}}
								/>
								<Area
									type="monotone"
									dataKey="cost"
									stroke="#22d3ee"
									fill="url(#cost)"
								/>
							</AreaChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>

				<Card className="glass">
					<CardHeader>
						<CardTitle>Top chains</CardTitle>
						<CardDescription>By total agent cost · all sessions</CardDescription>
					</CardHeader>
					<CardContent className="h-64">
						<ResponsiveContainer>
							<BarChart data={stats.top_chains}>
								<CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
								<XAxis dataKey="chain" stroke="#64748b" fontSize={12} />
								<YAxis stroke="#64748b" fontSize={12} />
								<Tooltip
									contentStyle={{
										background: "#020617",
										border: "1px solid #334155",
									}}
								/>
								<Bar dataKey="cost" fill="#a78bfa" radius={[6, 6, 0, 0]} />
							</BarChart>
						</ResponsiveContainer>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

// ─── Session detail (tabbed) — uses shared SSE ───────────────────────────────

function Detail({ session, selectedAgentId, onClearAgentFilter }: {
	session: DBSession;
	selectedAgentId?: string | null;
	onClearAgentFilter?: () => void;
}) {
	const { data: history, refresh } = usePolling(
		(signal) => api.sessionEvents(session.id, signal),
		10_000,
		[session.id],
	);

	return (
		<SessionTabs
			session={session}
			historyEvents={history ?? []}
			onRefresh={refresh}
			selectedAgentId={selectedAgentId}
			onClearAgentFilter={onClearAgentFilter}
		/>
	);
}

// ─── Mode 1: Session List Page (/) ───────────────────────────────────────────

function SessionListPage() {
	const navigate = useNavigate();
	const PAGE_SIZE = 100;
	const [sessionLimit, setSessionLimit] = useState(PAGE_SIZE);
	const [selectedUser, setSelectedUser] = useState(() => {
		try {
			return localStorage.getItem("mae-user") ?? "";
		} catch {
			return "";
		}
	});
	const {
		data: sessions,
		loading: sessionsLoading,
		error: sessionsError,
	} = usePolling(
		(signal) => api.sessions(signal, { limit: sessionLimit, user: selectedUser }),
		5_000,
		[sessionLimit, selectedUser],
	);
	const { data: health } = usePolling(
		(signal) => api.health(signal),
		30_000,
		[],
	);
	const { data: stats } = usePolling(
		(signal) => api.stats(signal),
		15_000,
		[],
	);
	const [selectedId, setSelectedId] = useState<string>();
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [pinnedSession, setPinnedSession] = useState<DBSession | null>(null);

	const handleSelect = useCallback((id: string) => {
		setSelectedId(id);
		setSelectedAgentId(null);
	}, []);

	const handleDoubleClick = useCallback(
		(id: string) => {
			navigate(`/session/${id}`);
		},
		[navigate],
	);

	const loadedSessions = sessions ?? [];
	const loadedSelected = loadedSessions.find((s) => s.id === selectedId);
	const selected = loadedSelected ?? (pinnedSession?.id === selectedId ? pinnedSession : undefined);

	useEffect(() => {
		if (!selectedId || loadedSelected) {
			if (loadedSelected) setPinnedSession(loadedSelected);
			return;
		}
		let cancelled = false;
		api.session(selectedId)
			.then((session) => {
				if (!cancelled) setPinnedSession(session);
			})
			.catch(() => {
				if (!cancelled) setPinnedSession(null);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId, loadedSelected]);

	return (
		<div className="flex h-screen overflow-hidden bg-grid">
			{/* Left panel: Session sidebar */}
			<ResizablePanel
				storageKey="mae-sidebar-width"
				minWidth={300}
				maxWidth={560}
				defaultWidth={340}
			>
				<SessionSidebar
					sessions={loadedSessions}
					totalSessions={selectedUser ? undefined : stats?.total_sessions}
					selectedUser={selectedUser}
					onUserChange={(user) => {
						setSelectedUser(user);
						setSessionLimit(PAGE_SIZE);
						setSelectedId(undefined);
						setPinnedSession(null);
						setSelectedAgentId(null);
					}}
					selectedId={selectedId}
					onSelect={handleSelect}
					onDoubleClick={handleDoubleClick}
					onLoadMore={() => setSessionLimit((current) => current + PAGE_SIZE)}
					hasMore={loadedSessions.length >= sessionLimit && (selectedUser !== "" || stats?.total_sessions == null || loadedSessions.length < stats.total_sessions)}
					loading={sessionsLoading}
					error={sessionsError}
				/>
			</ResizablePanel>

			{/* Middle + Right panels: single SSE provider */}
			{selected ? (
				<SessionSSEProvider sessionId={selected.id}>
					<ResizablePanel
						storageKey="mae-session-list-agent-panel-width"
						minWidth={260}
						maxWidth={420}
						defaultWidth={300}
					>
						<AgentTreePanel
							hideBack
							session={selected}
							selectedAgentId={selectedAgentId}
							onAgentSelect={setSelectedAgentId}
						/>
					</ResizablePanel>
					<div className="flex-1 min-w-0 flex flex-col overflow-hidden">
						<Detail session={selected} selectedAgentId={selectedAgentId} onClearAgentFilter={() => setSelectedAgentId(null)} />
					</div>
				</SessionSSEProvider>
			) : (
				<main className="flex flex-1 items-center justify-center p-6">
					<Card className="glass max-w-4xl w-full">
						<CardHeader>
							<CardTitle>Select a session</CardTitle>
							<CardDescription>
								Choose a run from the sidebar to inspect live events, agent
								graph, till-done progress, files changed, and cost breakdown.
								<br />
								<span className="text-zinc-600 text-xs mt-1 inline-block">
									Tip: Double-click a session to open in detail mode.
								</span>
							</CardDescription>
						</CardHeader>
						<CardContent>
							<StatsPanel data={stats ?? undefined} />
							<p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
								<HeartPulse size={14} />
								API: {health?.status || "checking"} · DB:{" "}
								{health?.db || "unknown"}
							</p>
						</CardContent>
					</Card>
				</main>
			)}
		</div>
	);
}

// ─── Mode 2: Session Detail Page (/session/:id) ──────────────────────────────

function SessionDetailPage() {
	const { id } = useParams<{ id: string }>();
	const [session, setSession] = useState<DBSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

	// Load session data
	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setLoading(true);

		api
			.session(id)
			.then((s) => {
				if (!cancelled) {
					setSession(s);
					setLoading(false);
				}
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : String(e));
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [id]);

	// Also poll for session updates (status changes, etc)
	const { data: freshSession } = usePolling(
		(signal) => api.session(id!, signal),
		10_000,
		[id],
	);

	// Use fresh data when available
	const activeSession = freshSession ?? session;

	if (loading) {
		return (
			<div className="flex h-screen items-center justify-center bg-grid text-zinc-500">
				Loading session…
			</div>
		);
	}

	if (error || !activeSession) {
		return (
			<div className="flex h-screen items-center justify-center bg-grid">
				<Card className="glass max-w-md">
					<CardContent className="p-6 text-center text-red-400">
						{error ?? "Session not found"}
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<SessionSSEProvider sessionId={activeSession.id}>
			<div className="flex h-screen overflow-hidden bg-grid">
				{/* Left panel: Agent tree */}
				<ResizablePanel
					storageKey="mae-session-detail-agent-panel-width"
					minWidth={260}
					maxWidth={500}
					defaultWidth={320}
				>
					<AgentTreePanel
						session={activeSession}
						selectedAgentId={selectedAgentId}
						onAgentSelect={setSelectedAgentId}
					/>
				</ResizablePanel>

				{/* Right panel: Tabbed session view */}
				<div className="flex-1 min-w-0 flex flex-col overflow-hidden">
					<Detail session={activeSession} selectedAgentId={selectedAgentId} onClearAgentFilter={() => setSelectedAgentId(null)} />
				</div>
			</div>
		</SessionSSEProvider>
	);
}

// ─── Root App with Router ─────────────────────────────────────────────────────

function AuthenticatedApp({ user, onLogout }: { user: DBUser; onLogout: () => void }) {
	return (
		<>
			<div className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
				<span>{user.display_name}</span>
				{user.role === "admin" ? <a className="text-cyan-300 hover:text-cyan-100" href="/admin">Admin</a> : null}
				<button className="text-zinc-500 hover:text-zinc-200" onClick={onLogout}>Logout</button>
			</div>
			<Routes>
				<Route path="/" element={<SessionListPage />} />
				<Route path="/session/:id" element={<SessionDetailPage />} />
				<Route path="/admin" element={<AdminTokenPanel currentUser={user} />} />
			</Routes>
		</>
	);
}

export default function App() {
	const [user, setUser] = React.useState<DBUser | null>(null);
	const [loading, setLoading] = React.useState(true);

	React.useEffect(() => {
		loadCurrentUser().then(setUser).finally(() => setLoading(false));
	}, []);

	async function handleLogout() {
		await logout().catch(() => undefined);
		setUser(null);
	}

	if (loading) {
		return <div className="min-h-screen bg-grid flex items-center justify-center text-zinc-400">Loading…</div>;
	}

	return (
		<BrowserRouter>
			<ErrorBoundary>
				{user ? <AuthenticatedApp user={user} onLogout={handleLogout} /> : <LoginPage onLogin={setUser} />}
			</ErrorBoundary>
		</BrowserRouter>
	);
}
