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
import type { DBSession } from "@/lib/types";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { usePolling } from "@/hooks/usePolling";
import { SessionSSEProvider } from "@/hooks/useSessionSSE";
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

// ─── Stats panel (shown when no session selected) ────────────────────────────

function StatsPanel() {
	const { data, loading, error } = usePolling(
		(signal) => api.stats(signal),
		15_000,
		[],
	);
	if (loading)
		return (
			<Card className="glass">
				<CardContent className="p-5 text-sm text-slate-400">
					Loading stats...
				</CardContent>
			</Card>
		);
	if (error || !data)
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
						["Sessions", formatNumber(data.total_sessions), Activity],
						["Agents", formatNumber(data.total_agents), Users],
						["Total Cost", formatCurrency(data.total_cost), CircleDollarSign],
						["Events", formatNumber(data.total_events), Zap],
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
						<CardDescription>Last 30 days</CardDescription>
					</CardHeader>
					<CardContent className="h-64">
						<ResponsiveContainer>
							<AreaChart data={data.cost_per_day}>
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
						<CardDescription>By total agent cost</CardDescription>
					</CardHeader>
					<CardContent className="h-64">
						<ResponsiveContainer>
							<BarChart data={data.top_chains}>
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

function Detail({ session }: { session: DBSession }) {
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
		/>
	);
}

// ─── Mode 1: Session List Page (/) ───────────────────────────────────────────

function SessionListPage() {
	const navigate = useNavigate();
	const {
		data: sessions,
		loading,
		error,
	} = usePolling((signal) => api.sessions(signal), 5_000, []);
	const { data: health } = usePolling(
		(signal) => api.health(signal),
		30_000,
		[],
	);
	const [selectedId, setSelectedId] = useState<string>();
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

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

	const selected = (sessions ?? []).find((s) => s.id === selectedId);

	return (
		<div className="flex h-screen overflow-hidden bg-grid">
			{/* Left panel: Session sidebar */}
			<ResizablePanel
				storageKey="mae-sidebar-width"
				minWidth={200}
				maxWidth={500}
				defaultWidth={288}
			>
				<SessionSidebar
					sessions={sessions ?? []}
					selectedId={selectedId}
					onSelect={handleSelect}
					onDoubleClick={handleDoubleClick}
					loading={loading}
					error={error}
				/>
			</ResizablePanel>

			{/* Middle panel: Agent tree (when session selected) */}
			{selected && (
				<SessionSSEProvider sessionId={selected.id}>
					<ResizablePanel
						storageKey="mae-agent-panel-width"
						minWidth={180}
						maxWidth={360}
						defaultWidth={240}
					>
						<AgentTreePanel
							hideBack
							session={selected}
							selectedAgentId={selectedAgentId}
							onAgentSelect={setSelectedAgentId}
						/>
					</ResizablePanel>
				</SessionSSEProvider>
			)}

			{/* Right panel: Session detail or placeholder */}
			{selected ? (
				<SessionSSEProvider sessionId={selected.id}>
					<div className="flex-1 min-w-0 flex flex-col overflow-hidden">
						<Detail session={selected} />
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
							<StatsPanel />
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
					storageKey="mae-agent-panel-width"
					minWidth={200}
					maxWidth={500}
					defaultWidth={288}
				>
					<AgentTreePanel
						session={activeSession}
						selectedAgentId={selectedAgentId}
						onAgentSelect={setSelectedAgentId}
					/>
				</ResizablePanel>

				{/* Right panel: Tabbed session view */}
				<div className="flex-1 min-w-0 flex flex-col overflow-hidden">
					<Detail session={activeSession} />
				</div>
			</div>
		</SessionSSEProvider>
	);
}

// ─── Root App with Router ─────────────────────────────────────────────────────

export default function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<SessionListPage />} />
				<Route path="/session/:id" element={<SessionDetailPage />} />
			</Routes>
		</BrowserRouter>
	);
}
