/**
 * AgentGraph — interactive SVG directed graph of agent hierarchy for a session.
 *
 * Layout: top-down tree. Each node is a rounded rect colored by team_color.
 * Edges connect parent → child. Nodes are clickable to open AgentDetail panel.
 * Real-time updates via shared SSE context (no duplicate connections).
 */

import * as React from "react";
import { api } from "@/lib/api";
import { buildAgentsFromEvents } from "@/lib/agents-from-events";
import { useSessionSSE } from "@/hooks/useSessionSSE";
import type { LiveAgent, DBEvent, LiveEvent } from "@/lib/types";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { AgentDetail } from "./AgentDetail";

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 164;
const NODE_H = 74;
const H_GAP = 32;
const V_GAP = 68;

interface NodeLayout {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

const TEAM_GROUP_GAP = 24; // extra horizontal gap between team groups
const TEAM_LABEL_H = 18; // height reserved for team label above group
const TEAM_PAD = 10; // padding inside team group rect

interface TeamGroup {
	team_name: string;
	team_color: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

// ─── Tree layout algorithm ────────────────────────────────────────────────────

function layoutTree(
	agents: LiveAgent[],
): { nodes: NodeLayout[]; teamGroups: TeamGroup[] } {
	if (agents.length === 0) return { nodes: [], teamGroups: [] };

	const children = new Map<string, string[]>();
	const byId = new Map<string, LiveAgent>();

	for (const a of agents) {
		byId.set(a.id, a);
		const pId = a.parent_id ?? "__root__";
		if (!children.has(pId)) children.set(pId, []);
		children.get(pId)!.push(a.id);
	}

	// Sort children of each parent by team_name so same-team nodes cluster
	for (const [, kids] of children) {
		kids.sort((a, b) => {
			const ta = byId.get(a)?.team_name ?? "";
			const tb = byId.get(b)?.team_name ?? "";
			return ta.localeCompare(tb);
		});
	}

	const roots = agents
		.filter((a) => !a.parent_id || !byId.has(a.parent_id))
		.map((a) => a.id);

	const positions = new Map<string, { x: number; y: number }>();

	function subtreeWidth(id: string): number {
		const kids = children.get(id) ?? [];
		if (kids.length === 0) return NODE_W;
		// Add extra gap between team boundaries
		let w = 0;
		let prevTeam: string | null = null;
		for (let i = 0; i < kids.length; i++) {
			const kidTeam = byId.get(kids[i])?.team_name ?? "";
			if (i > 0) {
				w += kidTeam !== prevTeam ? H_GAP + TEAM_GROUP_GAP : H_GAP;
			}
			w += subtreeWidth(kids[i]);
			prevTeam = kidTeam;
		}
		return Math.max(NODE_W, w);
	}

	function place(id: string, left: number, depth: number) {
		const kids = children.get(id) ?? [];
		const sw = subtreeWidth(id);
		positions.set(id, {
			x: left + sw / 2 - NODE_W / 2,
			y: depth * (NODE_H + V_GAP) + V_GAP,
		});
		let childLeft = left;
		let prevTeam: string | null = null;
		for (let i = 0; i < kids.length; i++) {
			const kidTeam = byId.get(kids[i])?.team_name ?? "";
			if (i > 0) {
				childLeft += kidTeam !== prevTeam ? H_GAP + TEAM_GROUP_GAP : H_GAP;
			}
			place(kids[i], childLeft, depth + 1);
			childLeft += subtreeWidth(kids[i]);
			prevTeam = kidTeam;
		}
	}

	let left = H_GAP;
	for (const r of roots) {
		place(r, left, 0);
		left += subtreeWidth(r) + H_GAP * 2;
	}

	const nodes = agents.map((a) => {
		const pos = positions.get(a.id) ?? { x: 0, y: 0 };
		return { id: a.id, x: pos.x, y: pos.y, width: NODE_W, height: NODE_H };
	});

	// Build team group bounding rects from direct children of each parent
	const teamGroups: TeamGroup[] = [];
	const nodeMap = new Map(nodes.map((n) => [n.id, n]));

	for (const [, kids] of children) {
		// Group kids by team_name
		const teams = new Map<string, string[]>();
		for (const kid of kids) {
			const team = byId.get(kid)?.team_name ?? "";
			if (!team) continue;
			if (!teams.has(team)) teams.set(team, []);
			teams.get(team)!.push(kid);
		}
		// Only draw group rects when there are 2+ teams (grouping adds value)
		if (teams.size < 2) continue;
		for (const [teamName, memberIds] of teams) {
			const memberLayouts = memberIds
				.map((id) => nodeMap.get(id))
				.filter(Boolean) as NodeLayout[];
			if (memberLayouts.length === 0) continue;
			const minX = Math.min(...memberLayouts.map((l) => l.x));
			const minY = Math.min(...memberLayouts.map((l) => l.y));
			const maxX = Math.max(...memberLayouts.map((l) => l.x + l.width));
			const maxY = Math.max(...memberLayouts.map((l) => l.y + l.height));
			const color = byId.get(memberIds[0])?.team_color ?? "#22d3ee";
			teamGroups.push({
				team_name: teamName,
				team_color: validColor(color),
				x: minX - TEAM_PAD,
				y: minY - TEAM_PAD - TEAM_LABEL_H,
				width: maxX - minX + TEAM_PAD * 2,
				height: maxY - minY + TEAM_PAD * 2 + TEAM_LABEL_H,
			});
		}
	}

	return { nodes, teamGroups };
}

// ─── Status styling ───────────────────────────────────────────────────────────

function ringStroke(status: string) {
	if (status === "running") return "#22d3ee";
	if (status === "done") return "#10b981";
	if (status === "error") return "#ef4444";
	if (status === "blocked") return "#f59e0b";
	return "#52525b";
}

function cardFill(status: string) {
	if (status === "running") return "rgba(8,51,68,0.85)";
	if (status === "done") return "rgba(6,46,37,0.6)";
	if (status === "error") return "rgba(69,10,10,0.6)";
	return "rgba(24,24,27,0.92)";
}

function dotFill(status: string) {
	if (status === "running") return "#22d3ee";
	if (status === "done") return "#10b981";
	if (status === "error") return "#ef4444";
	if (status === "blocked") return "#f59e0b";
	return "#52525b";
}

function validColor(c?: string) {
	return c && /^#[0-9a-f]{3,6}$/i.test(c) ? c : "#22d3ee";
}

// ─── SVG Node ─────────────────────────────────────────────────────────────────

interface NodeProps {
	agent: LiveAgent;
	layout: NodeLayout;
	selected: boolean;
	onClick: () => void;
}

function AgentNode({
	agent,
	layout,
	selected,
	onClick,
	dimmed,
}: NodeProps & { dimmed?: boolean }) {
	const { x, y, width, height } = layout;
	const rx = 10;
	const teamColor = validColor(agent.team_color);
	const stroke = selected ? "#22d3ee" : ringStroke(agent.status);

	return (
		<g
			onClick={onClick}
			style={{ cursor: "pointer", opacity: dimmed ? 0.2 : 1 }}
		>
			{/* Selected glow */}
			{selected && (
				<rect
					x={x - 5}
					y={y - 5}
					width={width + 10}
					height={height + 10}
					rx={rx + 5}
					fill="none"
					stroke="#22d3ee"
					strokeWidth={2}
					strokeOpacity={0.5}
					filter="url(#glow)"
				/>
			)}
			{agent.status === "running" && !selected && (
				<rect
					x={x - 4}
					y={y - 4}
					width={width + 8}
					height={height + 8}
					rx={rx + 4}
					fill="none"
					stroke="#22d3ee"
					strokeWidth={1.5}
					strokeOpacity={0.35}
					style={{ animation: "pulse-ring 1.6s ease-in-out infinite" }}
				/>
			)}
			<rect
				x={x}
				y={y}
				width={width}
				height={height}
				rx={rx}
				fill={cardFill(agent.status)}
				stroke={stroke}
				strokeWidth={selected ? 2 : 1.5}
			/>
			<rect x={x} y={y} width={width} height={5} rx={rx} fill={teamColor} />
			<rect x={x} y={y + 3} width={width} height={5} fill={teamColor} />
			<text
				x={x + width / 2}
				y={y + 23}
				textAnchor="middle"
				fill="#f4f4f5"
				fontSize={11}
				fontWeight={600}
				fontFamily="ui-monospace,monospace"
			>
				{agent.name.length > 20 ? `${agent.name.slice(0, 19)}…` : agent.name}
			</text>
			<rect
				x={x + width / 2 - 28}
				y={y + 27}
				width={56}
				height={14}
				rx={5}
				fill={`${teamColor}25`}
			/>
			<text
				x={x + width / 2}
				y={y + 38}
				textAnchor="middle"
				fill={teamColor}
				fontSize={8.5}
				fontWeight={700}
				fontFamily="ui-monospace,monospace"
				letterSpacing="0.05em"
			>
				{String(agent.role).toUpperCase()}
			</text>
			<text
				x={x + width / 2}
				y={y + 57}
				textAnchor="middle"
				fill="#71717a"
				fontSize={8.5}
				fontFamily="ui-sans-serif,system-ui,sans-serif"
			>
				{agent.model.length > 24 ? `${agent.model.slice(0, 23)}…` : agent.model}
			</text>
			<text
				x={x + width - 7}
				y={y + height - 6}
				textAnchor="end"
				fill="#22d3ee"
				fontSize={8}
				fontWeight={600}
				fontFamily="ui-monospace,monospace"
			>
				{formatCurrency(agent.cost_usd)}
			</text>
			<circle
				cx={x + 10}
				cy={y + height - 9}
				r={3.5}
				fill={dotFill(agent.status)}
			/>
		</g>
	);
}

// ─── SVG Edge ─────────────────────────────────────────────────────────────────

function Edge({
	from,
	to,
	color,
}: {
	from: NodeLayout;
	to: NodeLayout;
	color: string;
}) {
	const x1 = from.x + from.width / 2;
	const y1 = from.y + from.height;
	const x2 = to.x + to.width / 2;
	const y2 = to.y;
	const mid = (y1 + y2) / 2;
	return (
		<path
			d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
			fill="none"
			stroke={validColor(color)}
			strokeWidth={1.5}
			strokeOpacity={0.45}
			markerEnd="url(#arrow)"
		/>
	);
}

// ─── Event-sourced agent reconstruction ─────────────────────────────────────

/**
 * Rebuild the full agent tree from historical DB events.
 * This is the primary data source because the PG agents table is often
 * incomplete (circuit breaker drops creates under load). Events are
 * always persisted.
 */

// ─── Main Graph ───────────────────────────────────────────────────────────────

interface AgentGraphProps {
	sessionId: string;
	selectedAgentId?: string;
	onAgentSelect?: (agent: LiveAgent | null) => void;
	events?: DBEvent[];
}

export function AgentGraph({
	sessionId,
	selectedAgentId,
	onAgentSelect,
	events = [],
}: AgentGraphProps) {
	const [agents, setAgents] = React.useState<LiveAgent[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [selected, setSelected] = React.useState<string | null>(
		selectedAgentId ?? null,
	);
	const [activeFilters, setActiveFilters] = React.useState<Set<string>>(
		new Set(),
	);

	// Load agents by reconstructing from events (PG agents table is often
	// incomplete because the circuit breaker drops agent_create writes under
	// load). Events are the reliable source of truth.
	React.useEffect(() => {
		let cancelled = false;
		setLoading(true);

		Promise.all([
			api.sessionEvents(sessionId).catch(() => [] as DBEvent[]),
			api.sessionAgents(sessionId).catch(() => [] as LiveAgent[]),
		])
			.then(([dbEvents, pgAgents]) => {
				if (cancelled) return;

				const fromEvents = buildAgentsFromEvents(dbEvents);

				// Merge: event-sourced agents are authoritative; PG fills gaps
				const merged = new Map<string, LiveAgent>();
				for (const a of pgAgents) merged.set(a.id, a);
				// Event-sourced agents overwrite PG since they have parent_id linkage
				for (const a of fromEvents) merged.set(a.id, a);

				setAgents(Array.from(merged.values()));
				setLoading(false);
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : String(e));
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// Use shared SSE for real-time updates (no duplicate connection)
	const { subscribe } = useSessionSSE();

	React.useEffect(() => {
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
				};
				setAgents((prev) =>
					prev.some((a) => a.id === newAgent.id) ? prev : [...prev, newAgent],
				);
			} else if (event.event_type === "agent_done") {
				setAgents((prev) =>
					prev.map((a) =>
						a.id === event.agent_id ? { ...a, status: "done" } : a,
					),
				);
			} else if (event.event_type === "cost_update") {
				setAgents((prev) =>
					prev.map((a) =>
						a.id === event.agent_id
							? {
									...a,
									cost_usd: event.cost_usd ?? a.cost_usd,
									tokens_used: event.tokens_used ?? a.tokens_used,
									context_tokens: event.context_tokens ?? a.context_tokens,
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

	React.useEffect(() => {
		if (selectedAgentId !== undefined) setSelected(selectedAgentId ?? null);
	}, [selectedAgentId]);

	const { nodes: layouts, teamGroups } = React.useMemo(
		() => layoutTree(agents),
		[agents],
	);
	const agentById = React.useMemo(
		() => new Map(agents.map((a) => [a.id, a])),
		[agents],
	);
	const layoutById = React.useMemo(
		() => new Map(layouts.map((l) => [l.id, l])),
		[layouts],
	);

	const viewBox = React.useMemo(() => {
		if (layouts.length === 0) return "0 0 800 300";
		const maxX = Math.max(...layouts.map((l) => l.x + l.width));
		const maxY = Math.max(...layouts.map((l) => l.y + l.height));
		return `0 0 ${maxX + H_GAP * 2} ${maxY + V_GAP}`;
	}, [layouts]);

	const edges = React.useMemo(() => {
		const result: { from: NodeLayout; to: NodeLayout; color: string }[] = [];
		for (const agent of agents) {
			if (agent.parent_id) {
				const from = layoutById.get(agent.parent_id);
				const to = layoutById.get(agent.id);
				if (from && to) {
					const parent = agentById.get(agent.parent_id);
					result.push({
						from,
						to,
						color: parent?.team_color ?? agent.team_color ?? "#3f3f46",
					});
				}
			}
		}
		return result;
	}, [agents, agentById, layoutById]);

	const handleNodeClick = (agent: LiveAgent) => {
		const next = selected === agent.id ? null : agent.id;
		setSelected(next);
		onAgentSelect?.(next ? agent : null);
	};

	const selectedAgent = selected ? (agentById.get(selected) ?? null) : null;

	const toggleFilter = (status: string) => {
		setActiveFilters((prev) => {
			const next = new Set(prev);
			if (next.has(status)) next.delete(status);
			else next.add(status);
			return next;
		});
	};

	const countByStatus = (status: string) =>
		agents.filter((a) => a.status === status).length;

	const dotColorClass = (status: string) => {
		if (status === "running") return "bg-cyan-400";
		if (status === "done") return "bg-emerald-500";
		if (status === "error") return "bg-red-500";
		if (status === "blocked") return "bg-amber-500";
		return "bg-zinc-500";
	};

	const isFiltered = activeFilters.size > 0;

	if (loading)
		return (
			<div className="flex h-64 items-center justify-center text-zinc-500 text-sm">
				Loading agent graph…
			</div>
		);

	if (error)
		return (
			<div className="flex h-64 items-center justify-center text-red-400 text-sm">
				{error}
			</div>
		);

	if (agents.length === 0)
		return (
			<div className="flex h-64 items-center justify-center text-zinc-600 text-sm">
				No agents spawned yet
			</div>
		);

	return (
		<div className="flex gap-4 w-full">
			<div className="flex-1 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 min-h-64">
				{/* Status filter bar */}
				<div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-white/5">
					{(["running", "done", "error", "blocked"] as const).map((status) => (
						<button
							key={status}
							onClick={() => toggleFilter(status)}
							className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 border transition-all ${
								activeFilters.has(status)
									? "opacity-100 border-white/20 bg-white/5"
									: "opacity-50 border-transparent hover:opacity-75"
							}`}
						>
							<span
								className={`w-2 h-2 rounded-full ${dotColorClass(status)}`}
							/>
							<span className="text-zinc-300">
								{status} ({countByStatus(status)})
							</span>
						</button>
					))}
					{isFiltered && (
						<button
							onClick={() => setActiveFilters(new Set())}
							className="px-2 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
						>
							clear
						</button>
					)}
				</div>

				<svg viewBox={viewBox} className="w-full" style={{ minHeight: 200 }}>
					<defs>
						<marker
							id="arrow"
							viewBox="0 0 10 10"
							refX="9"
							refY="5"
							markerWidth={6}
							markerHeight={6}
							orient="auto-start-reverse"
						>
							<path d="M 0 0 L 10 5 L 0 10 z" fill="#3f3f46" />
						</marker>
						<filter id="glow">
							<feGaussianBlur stdDeviation="3" result="blur" />
							<feMerge>
								<feMergeNode in="blur" />
								<feMergeNode in="SourceGraphic" />
							</feMerge>
						</filter>
						<style>{`
              @keyframes pulse-ring {
                0%,100% { opacity: 0.15; }
                50% { opacity: 0.7; }
              }
            `}</style>
					</defs>

					{/* Team group backgrounds */}
					{teamGroups.map((tg) => (
						<g key={`team-${tg.team_name}`}>
							<rect
								x={tg.x}
								y={tg.y}
								width={tg.width}
								height={tg.height}
								rx={8}
								fill={`${tg.team_color}14`}
								stroke={`${tg.team_color}26`}
								strokeWidth={1}
							/>
							<text
								x={tg.x + TEAM_PAD}
								y={tg.y + 13}
								fill={`${tg.team_color}99`}
								fontSize={9}
								fontWeight={600}
								fontFamily="ui-sans-serif,system-ui,sans-serif"
								letterSpacing="0.04em"
							>
								{tg.team_name.toUpperCase()}
							</text>
						</g>
					))}

					{edges.map(({ from, to, color }, i) => (
						<Edge key={i} from={from} to={to} color={color} />
					))}
					{agents.map((agent) => {
						const layout = layoutById.get(agent.id);
						if (!layout) return null;
						const dimmed =
							isFiltered && !activeFilters.has(agent.status);
						return (
							<AgentNode
								key={agent.id}
								agent={agent}
								layout={layout}
								selected={selected === agent.id}
								onClick={() => handleNodeClick(agent)}
								dimmed={dimmed}
							/>
						);
					})}
				</svg>

				{/* Legend */}
				<div className="flex flex-wrap items-center gap-4 border-t border-zinc-800 px-4 py-2.5 text-xs text-zinc-500">
					<span className="ml-auto flex gap-3">
						<span>{agents.length} agents</span>
						<span className="text-cyan-400">
							{formatCurrency(agents.reduce((s, a) => s + a.cost_usd, 0))}
						</span>
						<span>
							{formatNumber(agents.reduce((s, a) => s + a.tokens_used, 0))} tok
						</span>
					</span>
				</div>
			</div>

			{selectedAgent && (
				<div className="w-80 shrink-0">
					<AgentDetail
						agent={selectedAgent}
						events={events}
						onClose={() => {
							setSelected(null);
							onAgentSelect?.(null);
						}}
					/>
				</div>
			)}
		</div>
	);
}
