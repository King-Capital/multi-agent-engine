/**
 * AgentTreePanel — Mode 2 left panel (compact vertical agent hierarchy).
 *
 * Displayed when viewing a session at /session/:id.
 * Shows a compact vertical list of agents from AgentGraph data:
 * - Agent name
 * - Role badge (O/L/W)
 * - Status dot
 * - Cost
 * - Click to highlight in stream (calls onAgentSelect)
 * - Back button to return to session list
 */

import * as React from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { buildAgentsFromEvents, mergeAgents } from "@/lib/agents-from-events";
import { useSessionSSE } from "@/hooks/useSessionSSE";
import type { LiveAgent, DBEvent, LiveEvent } from "@/lib/types";
import {
	agentColor,
	cn,
	formatCurrency,
	formatNumber,
	shortId,
	statusColor,
	statusDot,
} from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DBSession } from "@/lib/types";

// ─── Role badge ───────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, { letter: string; cls: string }> = {
	orchestrator: {
		letter: "O",
		cls: "bg-violet-500/20 text-violet-300 border-violet-700/50",
	},
	lead: { letter: "L", cls: "bg-blue-500/20 text-blue-300 border-blue-700/50" },
	worker: {
		letter: "W",
		cls: "bg-zinc-700/40 text-zinc-300 border-zinc-600/50",
	},
};

function RoleBadge({ role }: { role: string }) {
	const r = ROLE_LABELS[role] ?? ROLE_LABELS.worker;
	return (
		<span
			className={cn(
				"inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold border shrink-0",
				r.cls,
			)}
		>
			{r.letter}
		</span>
	);
}

// ─── Agent row ────────────────────────────────────────────────────────────────

function formatActivity(agent: LiveAgent): string {
	if (agent.current_activity) return agent.current_activity;
	return agent.role === "orchestrator" ? "coordinator" : "idle";
}

function formatModel(agent: LiveAgent): string | null {
	if (!agent.model || agent.model === "unknown") return null;
	return agent.model;
}

function activityAge(agent: LiveAgent): string | null {
	if (!agent.last_activity_at || agent.status !== "running") return null;
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(agent.last_activity_at).getTime()) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	return `${Math.floor(seconds / 60)}m ago`;
}

function AgentRow({
	agent,
	depth,
	selected,
	showTokens,
	onClick,
}: {
	agent: LiveAgent;
	depth: number;
	selected: boolean;
	showTokens?: boolean;
	onClick: () => void;
}) {
	const teamColor = agentColor(agent.role, agent.team_color);
	const age = activityAge(agent);
	const model = formatModel(agent);

	return (
		<button
			onClick={onClick}
			className={cn(
				"w-full text-left rounded-lg transition-colors overflow-hidden",
				selected
					? "ring-1 ring-white/20 bg-white/[0.06]"
					: "hover:bg-white/[0.04]",
			)}
			style={{ marginLeft: `${Math.min(depth, 3) * 10}px` }}
		>
			{/* Color bar (like the graph nodes) */}
			<div className="h-1 rounded-t-lg" style={{ backgroundColor: teamColor }} />

			<div className="flex items-center gap-2 px-2.5 py-1.5">
				{/* Status dot */}
				<span
					className={cn("w-2 h-2 rounded-full shrink-0", statusDot(agent.status))}
				/>

				{/* Role badge -- uses team color */}
				<span
					className="inline-flex items-center justify-center w-5 h-5 rounded text-[9px] font-bold shrink-0"
					style={{
						backgroundColor: `${teamColor}30`,
						color: teamColor,
						border: `1px solid ${teamColor}50`,
					}}
				>
					{agent.role === "orchestrator" ? "O" : agent.role === "lead" ? "L" : "W"}
				</span>

				{/* Name + model/activity */}
				<div className="flex-1 min-w-0">
					<div className="text-xs font-semibold text-zinc-200 break-words leading-tight">
						{agent.name}
					</div>
					<div className="flex items-center gap-1.5 min-w-0 text-[10px]">
						{model ? (
							<span
								className="font-mono rounded px-1 py-0.5 shrink-0"
								style={{ backgroundColor: `${teamColor}20`, color: teamColor }}
							>
								{model}
							</span>
						) : null}
						<span className="truncate text-zinc-500">
							{formatActivity(agent)}{age ? ` · ${age}` : ""}
						</span>
					</div>
				</div>

				{/* Cost / Tokens bubble */}
				<span className={cn(
					"text-[10px] font-mono font-bold shrink-0 px-1.5 py-0.5 rounded-full",
					showTokens
						? "bg-amber-500/20 text-amber-300"
						: "bg-emerald-500/20 text-emerald-300",
				)}>
					{showTokens ? formatNumber(agent.tokens_used) : formatCurrency(agent.cost_usd)}
				</span>
			</div>
		</button>
	);
}

// ─── Build tree structure ─────────────────────────────────────────────────────

interface AgentTreeNode {
	agent: LiveAgent;
	children: AgentTreeNode[];
	depth: number;
}

function buildTree(agents: LiveAgent[]): AgentTreeNode[] {
	const byId = new Map(agents.map((a) => [a.id, a]));
	const childMap = new Map<string, LiveAgent[]>();

	for (const a of agents) {
		const parentId = a.parent_id ?? "__root__";
		if (!childMap.has(parentId)) childMap.set(parentId, []);
		childMap.get(parentId)!.push(a);
	}

	const roots = agents.filter((a) => !a.parent_id || !byId.has(a.parent_id));

	function build(agent: LiveAgent, depth: number): AgentTreeNode {
		const kids = childMap.get(agent.id) ?? [];
		return {
			agent,
			depth,
			children: kids.map((k) => build(k, depth + 1)),
		};
	}

	return roots.map((r) => build(r, 0));
}

function flattenTree(
	nodes: AgentTreeNode[],
): { agent: LiveAgent; depth: number }[] {
	const result: { agent: LiveAgent; depth: number }[] = [];
	function walk(n: AgentTreeNode) {
		result.push({ agent: n.agent, depth: n.depth });
		for (const c of n.children) walk(c);
	}
	for (const n of nodes) walk(n);
	return result;
}


// ─── Main component ───────────────────────────────────────────────────────────

interface AgentTreePanelProps {
	session: DBSession;
	selectedAgentId?: string | null;
	onAgentSelect?: (agentId: string | null) => void;
	/** Hide the back button (used when inline on session list page) */
	hideBack?: boolean;
	/** Events-based session cost (more accurate than summing agent costs) */
	sessionCost?: number;
}

export function AgentTreePanel({
	session,
	selectedAgentId,
	onAgentSelect,
	hideBack,
	sessionCost,
}: AgentTreePanelProps) {
	const navigate = useNavigate();
	const [agents, setAgents] = React.useState<LiveAgent[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [showTokens, setShowTokens] = React.useState(false);
	const [eventsCost, setEventsCost] = React.useState(0);

	// Load agents from events + PG
	React.useEffect(() => {
		let cancelled = false;
		setLoading(true);

		Promise.all([
			api.sessionEvents(session.id).catch(() => [] as DBEvent[]),
			api.sessionAgents(session.id).catch(() => [] as LiveAgent[]),
		])
			.then(([dbEvents, pgAgents]) => {
				if (cancelled) return;
				const fromEvents = buildAgentsFromEvents(dbEvents);
				setAgents(mergeAgents(pgAgents, fromEvents));
				// Compute events-based cost from cost_update events
				const costFromEvents = dbEvents
					.filter((e) => e.event_type === "cost_update" && e.payload?.cost_usd != null)
					.reduce((sum, e) => sum + (Number(e.payload?.cost_usd) || 0), 0);
				setEventsCost(costFromEvents);
				setLoading(false);
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [session.id]);

	// SSE updates
	const { subscribe } = useSessionSSE();

	React.useEffect(() => {
		const markActivity = (agentId: string, activity: string) => {
			setAgents((prev) =>
				prev.map((a) =>
					a.id === agentId
						? { ...a, last_activity_at: new Date().toISOString(), current_activity: activity }
						: a,
				),
			);
		};

		const unsub = subscribe((event: LiveEvent) => {
			const d = event.data ?? {};
			if (event.event_type === "agent_spawn") {
				const newAgent: LiveAgent = {
					id: event.agent_id,
					name: String(d.agent_name ?? event.agent_id),
					role: String(d.agent_role ?? "worker"),
					model: String(d.model ?? ""),
					team_name: String(d.team_name ?? ""),
					team_color: String(d.team_color ?? "#22d3ee"),
					parent_id: event.parent_id,
					status: "running",
					persona_path: d.persona_path ? String(d.persona_path) : undefined,
					cost_usd: 0,
					tokens_used: 0,
					context_tokens: 0,
					context_max: 0,
					started_at: event.timestamp ?? new Date().toISOString(),
					elapsed_ms: 0,
					last_activity_at: event.timestamp ?? new Date().toISOString(),
					current_activity: "spawned",
				};
				setAgents((prev) => {
					const existing = prev.find((a) => a.id === newAgent.id);
					if (!existing) return [...prev, newAgent];
					return prev.map((a) =>
						a.id === newAgent.id
							? {
									...a,
									name: newAgent.name,
									role: newAgent.role,
									model: newAgent.model && newAgent.model !== "unknown" ? newAgent.model : a.model,
									team_name: newAgent.team_name || a.team_name,
									team_color: newAgent.team_color || a.team_color,
									parent_id: newAgent.parent_id ?? a.parent_id,
									persona_path: newAgent.persona_path ?? a.persona_path,
									status: newAgent.status,
									last_activity_at: newAgent.last_activity_at,
									current_activity: newAgent.current_activity,
								}
							: a,
					);
				});
			} else if (event.event_type === "agent_done") {
				setAgents((prev) =>
					prev.map((a) =>
						a.id === event.agent_id ? { ...a, status: "done" } : a,
					),
				);
			} else if (event.event_type === "tool_call") {
				markActivity(event.agent_id, String(d.tool ?? "tool call"));
			} else if (event.event_type === "tool_result") {
				markActivity(event.agent_id, String(d.tool ?? "tool result"));
			} else if (event.event_type === "message" || event.event_type === "agent_message") {
				markActivity(event.agent_id, "message");
			} else if (event.event_type === "cost_update") {
				setAgents((prev) =>
					prev.map((a) =>
						a.id === event.agent_id
							? {
									...a,
									cost_usd: event.cost_usd ?? a.cost_usd,
									tokens_used: event.tokens_used ?? a.tokens_used,
									context_tokens: event.context_tokens ?? a.context_tokens,
									last_activity_at: event.timestamp ?? new Date().toISOString(),
									current_activity: "cost update",
								}
							: a,
					),
				);
			} else if (event.event_type === "error") {
				setAgents((prev) =>
					prev.map((a) =>
						a.id === event.agent_id ? { ...a, status: "error" } : a,
					),
				);
			}
		});
		return unsub;
	}, [subscribe]);

	const tree = React.useMemo(() => buildTree(agents), [agents]);
	const flat = React.useMemo(() => flattenTree(tree), [tree]);
	const agentCostSum = agents.reduce((s, a) => s + a.cost_usd, 0);
	const totalCost = agentCostSum > 0 ? agentCostSum : Math.max(sessionCost ?? 0, eventsCost);
	const totalTokens = agents.reduce((s, a) => s + a.tokens_used, 0);

	return (
		<div className="flex h-full w-full flex-col">
			{/* Back + Session header */}
			<div className="shrink-0 p-4 border-b border-white/5">
				{!hideBack && (
					<button
						onClick={() => navigate("/")}
						className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-2"
					>
						<ArrowLeft className="w-3.5 h-3.5" />
						Sessions
					</button>
				)}
				<h2 className="text-sm font-bold text-zinc-100 line-clamp-2">
					{session.name}
				</h2>
				<div className="flex flex-wrap items-center gap-2 mt-1">
					<Badge className={statusColor(session.status)} variant="outline">
						{session.status}
					</Badge>
					<span className="text-xs text-zinc-500">{shortId(session.id)}</span>
				</div>
			</div>

			{/* Agent count + cost/token toggle */}
			<div className="shrink-0 px-4 py-2 border-b border-white/5 flex flex-wrap items-center justify-between gap-y-1 text-xs text-zinc-500">
				<span>{agents.length} agents</span>
				<button
					onClick={() => setShowTokens((v) => !v)}
					className={cn(
						"px-2 py-0.5 rounded-full text-[10px] font-bold font-mono transition-colors",
						showTokens
							? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
							: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
					)}
					title={showTokens ? "Click for cost" : "Click for tokens"}
				>
					{showTokens ? `${formatNumber(totalTokens)} tok` : formatCurrency(totalCost)}
				</button>
			</div>

			{/* Agent tree list */}
			<ScrollArea className="flex-1 px-2 py-2">
				{loading && (
					<div className="flex items-center justify-center h-24 text-zinc-600 text-xs">
						Loading agents…
					</div>
				)}
				{!loading && flat.length === 0 && (
					<div className="flex items-center justify-center h-24 text-zinc-600 text-xs">
						No agents spawned
					</div>
				)}
				<div className="space-y-0.5">
					{flat.map(({ agent, depth }) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							depth={depth}
							selected={selectedAgentId === agent.id}
							onClick={() =>
								onAgentSelect?.(selectedAgentId === agent.id ? null : agent.id)
							}
						/>
					))}
				</div>
			</ScrollArea>
		</div>
	);
}
