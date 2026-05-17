/**
 * SessionTabs — tabbed interface for the session detail view.
 * Integrates: Stream | Agents | Till Done | Files | Cost | Replay
 *
 * Uses shared SSE from SessionSSEProvider (parent wraps this).
 */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import {
	Activity,
	Bot,
	CheckSquare,
	Columns3,
	DollarSign,
	FolderOpen,
	MessageSquare,
	PlayCircle,
	RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentGraph } from "@/components/AgentGraph";
import { TillDone } from "@/components/TillDone";
import { FilesView } from "@/components/FilesView";
import { CostBreakdown } from "@/components/CostBreakdown";
import { ReplayPlayer } from "@/components/ReplayPlayer";
import { SessionStatusBar } from "@/components/SessionStatusBar";
import { BoardTab } from "@/components/BoardTab";
import { api } from "@/lib/api";
import { buildAgentsFromEvents, mergeAgents } from "@/lib/agents-from-events";
import { deriveSessionStatus, mergeSessionEvents } from "@/lib/session-events";
import { usePolling } from "@/hooks/usePolling";
import { useSessionSSE } from "@/hooks/useSessionSSE";
import type { DBSession, DBEvent, LiveEvent } from "@/lib/types";
import { agentColor, cn, formatDurationMs, shortId, statusColor } from "@/lib/utils";

// ─── Stream components (conversation-style, matching old dashboard UX) ────────

/** Role badge letter */
function roleBadge(role?: string): string {
	switch (role) {
		case "orchestrator":
			return "O";
		case "lead":
			return "L";
		case "worker":
			return "W";
		default:
			return "";
	}
}

/** Resolve a display name + color for an agent from the event data */
function agentDisplay(ev: LiveEvent): {
	name: string;
	color: string;
	role: string;
	model: string;
} {
	const d = ev.data ?? {};
	const name = d.agent_name ?? ev.agent_id ?? "unknown";
	const color = agentColor(d.agent_role as string | undefined, d.team_color as string | undefined);
	const role = (d.agent_role as string) ?? "";
	const rawModel = (d.model as string) ?? "";
	const model = rawModel;
	return { name, color, role, model };
}

function formatEventTime(ts?: string): string {
	return new Date(ts ?? Date.now()).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Tool call status icon */
function toolStatusIcon(status?: string): string {
	switch (status) {
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "blocked":
			return "⊘";
		default:
			return "…";
	}
}

function toolStatusColor(status?: string): string {
	switch (status) {
		case "success":
			return "text-green-500";
		case "error":
			return "text-red-500";
		case "blocked":
			return "text-red-400";
		default:
			return "text-zinc-500";
	}
}

// ── Markdown renderer with styling ────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
	type C = { children?: React.ReactNode };
	return (
		<ReactMarkdown
			components={{
				h1: ({ children }: C) => (
					<h1 className="text-base font-bold text-zinc-100 mt-3 mb-1.5 first:mt-0">
						{children}
					</h1>
				),
				h2: ({ children }: C) => (
					<h2 className="text-sm font-bold text-zinc-200 mt-2.5 mb-1 first:mt-0">
						{children}
					</h2>
				),
				h3: ({ children }: C) => (
					<h3 className="text-sm font-semibold text-zinc-200 mt-2 mb-1 first:mt-0">
						{children}
					</h3>
				),
				p: ({ children }: C) => (
					<p className="text-sm text-zinc-300 mb-1.5 last:mb-0 leading-relaxed">
						{children}
					</p>
				),
				ul: ({ children }: C) => (
					<ul className="text-sm text-zinc-300 list-disc pl-4 mb-1.5 space-y-0.5">
						{children}
					</ul>
				),
				ol: ({ children }: C) => (
					<ol className="text-sm text-zinc-300 list-decimal pl-4 mb-1.5 space-y-0.5">
						{children}
					</ol>
				),
				li: ({ children }: C) => (
					<li className="text-sm text-zinc-300">{children}</li>
				),
				strong: ({ children }: C) => (
					<strong className="font-bold text-zinc-100">{children}</strong>
				),
				em: ({ children }: C) => (
					<em className="italic text-zinc-300">{children}</em>
				),
				a: ({ href, children }: C & { href?: string }) => (
					<a
						href={href}
						className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
						target="_blank"
						rel="noopener noreferrer"
					>
						{children}
					</a>
				),
				code: ({ className, children, ...props }: any) => {
					const isInline = !className;
					if (isInline) {
						return (
							<code className="bg-white/[0.06] text-cyan-300 text-xs px-1 py-0.5 rounded font-mono">
								{children}
							</code>
						);
					}
					return (
						<code
							className={cn(
								"block bg-black/40 border border-white/5 rounded-md p-2 text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all",
								className,
							)}
							{...props}
						>
							{children}
						</code>
					);
				},
				pre: ({ children }: C) => <div className="mb-1.5">{children}</div>,
				blockquote: ({ children }: C) => (
					<blockquote className="border-l-2 border-zinc-600 pl-3 text-sm text-zinc-400 italic mb-1.5">
						{children}
					</blockquote>
				),
			}}
		>
			{content}
		</ReactMarkdown>
	);
}

// ── Message bubble (prominent) ────────────────────────────────────────────────

function MessageBubble({ ev }: { ev: LiveEvent }) {
	const { name, color, role } = agentDisplay(ev);
	const content = ev.data?.content ?? "";
	return (
		<div className="mb-3">
			<div className="flex items-center gap-2 mb-0.5">
				{role && (
					<span className="text-xs font-bold" style={{ color }}>
						{roleBadge(role)}
					</span>
				)}
				<span className="text-xs font-bold" style={{ color }}>
					{name}
				</span>
				<span className="text-xs text-zinc-600">
					{formatEventTime(ev.timestamp)}
				</span>
			</div>
			<div className="rounded-md bg-white/[0.03] border border-white/5 p-2.5 ml-4 break-words">
				<MarkdownContent content={content} />
			</div>
		</div>
	);
}

// ── Domain block entry (inline) ───────────────────────────────────────────────

function DomainBlockEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	return (
		<div className="mb-2 ml-4 rounded-md bg-white/[0.03] border border-white/5 border-l-2 border-l-red-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-red-400">⊘</span>
				<span className="text-red-400 font-bold">Domain Block</span>
			</div>
			<p className="text-xs text-zinc-400 mt-0.5">
				{d.blocked_action} on {d.blocked_path} — {d.block_reason}
			</p>
		</div>
	);
}

// ── Self-heal entry (inline) ──────────────────────────────────────────────────

function SelfHealEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	return (
		<div className="mb-2 ml-4 rounded-md bg-white/[0.03] border border-white/5 border-l-2 border-l-yellow-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-yellow-400">🔧</span>
				<span className="text-yellow-400 font-bold">Self-Heal</span>
			</div>
			<p className="text-xs text-zinc-400 mt-0.5">
				Worker {d.failed_worker} failed. Lead taking over: {d.heal_action}
			</p>
		</div>
	);
}

// ── Error entry (inline) ──────────────────────────────────────────────────────

function ErrorEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	return (
		<div className="mb-2 ml-4 rounded-md bg-white/[0.03] border border-white/5 border-l-2 border-l-red-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-red-400">⚠</span>
				<span className="text-red-400 font-bold">Error</span>
				<span className="text-zinc-500">{ev.agent_id}</span>
			</div>
			<p className="text-xs text-red-300 mt-0.5">{d.error_msg}</p>
		</div>
	);
}

// ── Monitor events (stall, nudge, budget, auto-pause) ────────────────────────

function StallEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	return (
		<div className="mb-2 ml-4 rounded-md bg-white/[0.03] border border-white/5 border-l-2 border-l-yellow-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-yellow-400">⏳</span>
				<span className="text-yellow-400 font-bold">Stall Detected</span>
				<span className="text-zinc-500">{String(d.agent_name ?? "")}</span>
			</div>
			<p className="text-xs text-yellow-300/70 mt-0.5">
				Idle for {String(d.idle_seconds ?? "?")}s
			</p>
		</div>
	);
}

function NudgeEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	const typeLabel = d.nudge_type === "web_search" ? "Web Search" : d.nudge_type === "llm_escalated" ? "LLM Nudge" : "Nudge";
	const nudgeMsg = typeof d.nudge_message === "string" ? d.nudge_message : "";
	return (
		<div className="mb-2 ml-4 rounded-md bg-white/[0.03] border border-white/5 border-l-2 border-l-blue-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-blue-400">💬</span>
				<span className="text-blue-400 font-bold">{typeLabel} #{String(d.nudge_count)}</span>
				<span className="text-zinc-500">→ {String(d.agent_name ?? "")}</span>
			</div>
			{nudgeMsg && (
				<p className="text-xs text-zinc-400 mt-0.5 truncate max-w-md" title={nudgeMsg}>
					{nudgeMsg.slice(0, 120)}
				</p>
			)}
		</div>
	);
}

function BudgetWarningEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	const pct = typeof d.percent_used === "number" ? d.percent_used.toFixed(0) : "?";
	const cost = typeof d.current_cost === "number" ? d.current_cost.toFixed(2) : "?";
	const proj = typeof d.projected_cost === "number" ? d.projected_cost.toFixed(2) : "?";
	return (
		<div className="mb-2 ml-4 rounded-md bg-orange-950/30 border border-orange-900/40 border-l-2 border-l-orange-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-orange-400">⚡</span>
				<span className="text-orange-400 font-bold">Budget Warning</span>
			</div>
			<p className="text-xs text-orange-300/70 mt-0.5">
				{pct}% used (${cost} current, ${proj} projected)
			</p>
		</div>
	);
}

function SeverityAlertEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	const severity = String(d.severity ?? "");
	const isP0 = severity === "P0";
	const borderColor = isP0 ? "border-l-red-600/70" : "border-l-orange-500/50";
	const bgColor = isP0 ? "bg-red-950/40" : "bg-orange-950/30";
	const textColor = isP0 ? "text-red-400" : "text-orange-400";
	const excerptColor = isP0 ? "text-red-300/70" : "text-orange-300/70";
	return (
		<div className={`mb-2 ml-4 rounded-md ${bgColor} border border-white/5 border-l-2 ${borderColor} p-2`}>
			<div className="flex items-center gap-1.5 text-xs">
				<span className={textColor}>🚨</span>
				<span className={`${textColor} font-bold`}>{severity} Finding</span>
			</div>
			{typeof d.excerpt === "string" && d.excerpt && (
				<p className={`text-xs ${excerptColor} mt-0.5`}>
					{d.excerpt.slice(0, 200)}
				</p>
			)}
		</div>
	);
}

function AutoPauseEntry({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	return (
		<div className="mb-2 ml-4 rounded-md bg-red-950/30 border border-red-900/40 border-l-2 border-l-red-500/50 p-2">
			<div className="flex items-center gap-1.5 text-xs">
				<span className="text-red-400">⏸</span>
				<span className="text-red-400 font-bold">Session Auto-Paused</span>
			</div>
			<p className="text-xs text-red-300/70 mt-0.5">
				Reason: {String(d.reason ?? "unknown")}
			</p>
		</div>
	);
}

// ── Agent spawn / done (brief inline) ─────────────────────────────────────────

function AgentSpawnLine({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	const name = d.agent_name ?? ev.agent_id ?? "unknown";
	const color = agentColor(d.agent_role as string | undefined, d.team_color as string | undefined);
	const role = d.agent_role ?? "";
	const model = d.model ?? "";
	return (
		<div className="flex items-center gap-1.5 text-xs text-zinc-500 py-0.5 ml-4">
			<span className="text-purple-400">→</span>
			<span className="font-medium" style={{ color }}>
				{name}
			</span>
			{role && <span className="text-zinc-600">({role})</span>}
			{model && (
				<span className="text-zinc-700 truncate max-w-[120px]">{model}</span>
			)}
			<span className="text-zinc-700">joined</span>
			<span className="text-zinc-700 ml-auto">
				{formatEventTime(ev.timestamp)}
			</span>
		</div>
	);
}

function AgentDoneLine({ ev }: { ev: LiveEvent }) {
	const d = ev.data ?? {};
	const name = d.agent_name ?? ev.agent_id ?? "unknown";
	const grade = d.grade ?? d.status ?? "";
	return (
		<div className="flex items-center gap-1.5 text-xs text-zinc-500 py-0.5 ml-4">
			<span className="text-emerald-400">✓</span>
			<span className="font-medium text-zinc-400">{name}</span>
			<span className="text-zinc-700">done</span>
			{grade && <span className="text-zinc-600">({grade})</span>}
			<span className="text-zinc-700 ml-auto">
				{formatEventTime(ev.timestamp)}
			</span>
		</div>
	);
}

// ── Tool call row (collapsed, shown inside expander) ──────────────────────────

function ToolCallRow({ ev }: { ev: LiveEvent }) {
	const [open, setOpen] = React.useState(false);
	const d = ev.data ?? {};
	const { name, color } = agentDisplay(ev);

	return (
		<div className="mb-1 ml-4 text-xs">
			<button
				className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 transition-colors w-full text-left"
				onClick={() => setOpen(!open)}
			>
				<span className="text-zinc-600 w-3 shrink-0">{open ? "▼" : "▶"}</span>
				<span className={cn("font-medium", toolStatusColor(d.tool_status))}>
					{toolStatusIcon(d.tool_status)}
				</span>
				<span className="font-medium" style={{ color }}>
					{name}
				</span>
				<span className="text-zinc-400">{d.tool}</span>
				{d.file_path && (
					<span className="text-zinc-500 truncate max-w-xs" title={d.file_path}>
						{d.file_path}
					</span>
				)}
				<span className="text-zinc-700 ml-auto shrink-0">
					{formatEventTime(ev.timestamp)}
				</span>
			</button>
			{open && (
				<div className="mt-1 ml-4 space-y-1">
					{d.tool_args && (
						<div className="rounded bg-white/[0.03] border border-white/5 p-1.5">
							<p className="text-zinc-600 mb-0.5 font-bold">args</p>
							<pre className="text-zinc-400 whitespace-pre-wrap break-all text-xs max-h-32 overflow-y-auto">
								{d.tool_args}
							</pre>
						</div>
					)}
					{d.tool_result && (
						<div className="rounded bg-white/[0.03] border border-white/5 p-1.5">
							<p className="text-zinc-600 mb-0.5 font-bold">result</p>
							<pre className="text-zinc-400 whitespace-pre-wrap break-all text-xs max-h-32 overflow-y-auto">
								{d.tool_result}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Stream tab ───────────────────────────────────────────────────────────────

interface StreamTabProps {
	sessionId: string;
	liveEvents: LiveEvent[];
	historyEvents: DBEvent[];
	streamError: string | null;
	message: string;
	sendError: string | null;
	pendingAckId?: string | null;
	onMessageChange: (v: string) => void;
	onSend: () => void;
	selectedAgentId?: string | null;
	onClearFilter?: () => void;
}

/** Unique key for an agent — uses agent_name from data, falls back to agent_id */
function agentKey(ev: LiveEvent): string {
	return ev.data?.agent_name ?? ev.agent_id ?? "unknown";
}

/** Info about a unique agent in the stream */
interface AgentInfo {
	name: string;
	color: string;
	role: string;
}

/** Data for one agent section in the grouped stream */
interface AgentSection {
	info: AgentInfo;
	messages: LiveEvent[];
	toolCalls: LiveEvent[];
	/** Other visible events: domain_block, self_heal, error, agent_spawn, agent_done */
	otherEvents: LiveEvent[];
}

// ── Agent filter pills ────────────────────────────────────────────────────────

function AgentFilterPills({
	agents,
	activeFilters,
	onToggle,
}: {
	agents: AgentInfo[];
	activeFilters: Set<string>;
	onToggle: (name: string) => void;
}) {
	const allActive = activeFilters.size === 0;
	const activeCount = activeFilters.size;

	// Compact dropdown for 5+ agents, pills for fewer
	if (agents.length > 4) {
		return (
			<div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5">
				<span className="text-xs text-zinc-600">Agents:</span>
				<div className="flex flex-wrap gap-1 flex-1 min-w-0">
					<button
						className={cn(
							"px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
							allActive
								? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
								: "bg-white/[0.04] text-zinc-500 border border-white/5 hover:text-zinc-300",
						)}
						onClick={() => onToggle("__all__")}
					>
						All ({agents.length})
					</button>
					{agents.map((a) => {
						const isActive = activeFilters.has(a.name);
						// Truncate long names
						const shortName = a.name.length > 14 ? a.name.slice(0, 12) + "\u2026" : a.name;
						return (
							<button
								key={a.name}
								title={a.name}
								className={cn(
									"px-2 py-0.5 rounded text-[11px] font-medium transition-colors max-w-[120px] truncate",
									isActive
										? "border"
										: "bg-white/[0.04] text-zinc-500 border border-white/5 hover:text-zinc-300",
								)}
								style={
									isActive
										? {
												backgroundColor: `${a.color}20`,
												color: a.color,
												borderColor: `${a.color}66`,
											}
										: undefined
								}
								onClick={() => onToggle(a.name)}
							>
								{shortName}
							</button>
						);
					})}
				</div>
				{activeCount > 0 && (
					<button
						className="text-[10px] text-zinc-600 hover:text-zinc-400 shrink-0"
						onClick={() => onToggle("__all__")}
					>
						clear
					</button>
				)}
			</div>
		);
	}

	// Small agent count: full pills
	return (
		<div className="shrink-0 flex flex-wrap gap-1.5 px-3 py-2 border-b border-white/5">
			<button
				className={cn(
					"px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
					allActive
						? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
						: "bg-white/[0.04] text-zinc-500 border border-white/5 hover:text-zinc-300",
				)}
				onClick={() => onToggle("__all__")}
			>
				All
			</button>
			{agents.map((a) => {
				const isActive = activeFilters.has(a.name);
				return (
					<button
						key={a.name}
						className={cn(
							"px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
							isActive
								? "border"
								: "bg-white/[0.04] text-zinc-500 border border-white/5 hover:text-zinc-300",
						)}
						style={
							isActive
								? {
										backgroundColor: `${a.color}20`,
										color: a.color,
										borderColor: `${a.color}66`,
									}
								: undefined
						}
						onClick={() => onToggle(a.name)}
					>
						{a.name}
					</button>
				);
			})}
		</div>
	);
}

// ── Agent section (grouped messages + collapsed tool calls) ───────────────────

function AgentSectionBlock({ section }: { section: AgentSection }) {
	const [showTools, setShowTools] = React.useState(false);
	const { info } = section;

	if (
		section.messages.length === 0 &&
		section.toolCalls.length === 0 &&
		section.otherEvents.length === 0
	) {
		return null;
	}

	return (
		<div
			className="mb-4 rounded-md border border-white/5 bg-white/[0.01] overflow-hidden"
			style={{ borderLeftWidth: 3, borderLeftColor: info.color }}
		>
			{/* Agent name header */}
			<div className="flex items-center gap-2 px-3 py-2 border-b border-white/5 bg-white/[0.04]">
				<span
					className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
					style={{
						backgroundColor: `${info.color}20`,
						color: info.color,
					}}
				>
					{roleBadge(info.role) || "A"}
				</span>
				<span className="text-sm font-bold" style={{ color: info.color }}>
					{info.name}
				</span>
				{info.role && (
					<span className="text-xs text-zinc-600">({info.role})</span>
				)}
				<span className="text-xs text-zinc-700 ml-auto">
					{section.messages.length} msg · {section.toolCalls.length} tools
				</span>
			</div>

			<div className="p-3 space-y-1">
				{/* Other events (spawns, errors, domain blocks, self-heals, done) */}
				{section.otherEvents.map((ev, i) => {
					switch (ev.event_type) {
						case "domain_block":
							return <DomainBlockEntry key={`db-${i}`} ev={ev} />;
						case "self_heal":
							return <SelfHealEntry key={`sh-${i}`} ev={ev} />;
						case "error":
							return <ErrorEntry key={`err-${i}`} ev={ev} />;
						case "agent_spawn":
							return <AgentSpawnLine key={`sp-${i}`} ev={ev} />;
						case "agent_done":
							return <AgentDoneLine key={`ad-${i}`} ev={ev} />;
						case "stall_detected":
							return <StallEntry key={`stall-${i}`} ev={ev} />;
						case "nudge_sent":
							return <NudgeEntry key={`nudge-${i}`} ev={ev} />;
						case "budget_warning":
							return <BudgetWarningEntry key={`bw-${i}`} ev={ev} />;
						case "severity_alert":
							return <SeverityAlertEntry key={`sev-${i}`} ev={ev} />;
						case "auto_pause":
							return <AutoPauseEntry key={`ap-${i}`} ev={ev} />;
						default:
							return null;
					}
				})}

				{/* Messages */}
				{section.messages.map((ev, i) => {
					const content = ev.data?.content ?? "";
					return (
						<div key={`msg-${i}`} className="mb-2">
							<div className="flex items-center gap-2 mb-0.5">
								<span className="text-xs text-zinc-600">
									{formatEventTime(ev.timestamp)}
								</span>
							</div>
							<div className="rounded-md bg-white/[0.03] border border-white/5 p-2.5 break-words">
								<MarkdownContent content={content} />
							</div>
						</div>
					);
				})}

				{/* Tool calls — collapsed */}
				{section.toolCalls.length > 0 && (
					<div className="pt-1">
						<button
							className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors flex items-center gap-1"
							onClick={() => setShowTools(!showTools)}
						>
							<span>{showTools ? "▼" : "▶"}</span>
							<span>Tool calls ({section.toolCalls.length})</span>
						</button>
						{showTools && (
							<div className="mt-1">
								{section.toolCalls.map((ev, i) => (
									<ToolCallRow key={`tc-${i}`} ev={ev} />
								))}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function isSteerEvent(ev: LiveEvent): boolean {
	if (ev.event_type !== "message") return false;
	const from = String(ev.data?.from ?? ev.agent_id ?? "").toLowerCase();
	return ev.agent_id === "user" || from === "user" || Boolean(ev.data?.ack_for);
}

function formatSteerPeer(ev: LiveEvent): string {
	if (ev.data?.ack_for) return "orchestrator";
	return String(ev.data?.to ?? "orchestrator");
}

function StreamTab({
	sessionId,
	liveEvents,
	historyEvents,
	streamError,
	message,
	sendError,
	pendingAckId,
	onMessageChange,
	onSend,
	selectedAgentId,
	onClearFilter,
}: StreamTabProps) {
	const bottomRef = React.useRef<HTMLDivElement>(null);
	const scrollRef = React.useRef<HTMLDivElement>(null);
	const [autoFollow, setAutoFollow] = React.useState(true);
	const [activeFilters, setActiveFilters] = React.useState<Set<string>>(
		new Set(),
	);

	React.useEffect(() => {
		if (autoFollow) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [liveEvents.length, autoFollow]);

	const handleScroll = React.useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
		if (!nearBottom && autoFollow) setAutoFollow(false);
		if (nearBottom && !autoFollow) setAutoFollow(true);
	}, [autoFollow]);

	const allEvents: LiveEvent[] = React.useMemo(() => mergeSessionEvents(historyEvents, liveEvents), [historyEvents, liveEvents]);

	const ackEvent = React.useMemo(() => {
		if (!pendingAckId) return null;
		return allEvents.find((ev) => ev.event_type === "message" && ev.data?.ack_for === pendingAckId) ?? null;
	}, [allEvents, pendingAckId]);

	const steerEvents = React.useMemo(
		() => allEvents.filter(isSteerEvent).slice(-8),
		[allEvents],
	);

	// Skip non-visual events entirely
	const SKIP_TYPES = new Set([
		"cost_update",
		"tilldone",
		"session_start",
		"session_end",
		"pause",
		"resume",
		"waiting",
	]);

	// Build per-agent sections: group events by agent, keep order of first appearance
	const { agentSections, allAgents } = React.useMemo(() => {
		const agentMap = new Map<string, AgentSection>();
		const agentOrder: string[] = [];

		for (const ev of allEvents) {
			if (SKIP_TYPES.has(ev.event_type) || isSteerEvent(ev)) continue;

			const key = agentKey(ev);
			if (!agentMap.has(key)) {
				const display = agentDisplay(ev);
				agentMap.set(key, {
					info: display,
					messages: [],
					toolCalls: [],
					otherEvents: [],
				});
				agentOrder.push(key);
			}

			const section = agentMap.get(key)!;
			// Update color/role if better data arrives (spawn events have team_color)
			if (ev.data?.team_color) {
				section.info.color = ev.data.team_color;
			}
			if (ev.data?.agent_role) {
				section.info.role = ev.data.agent_role;
			}

			if (ev.event_type === "tool_call") {
				section.toolCalls.push(ev);
			} else if (ev.event_type === "message") {
				section.messages.push(ev);
			} else {
				section.otherEvents.push(ev);
			}
		}

		const sections = agentOrder.map((k) => agentMap.get(k)!);
		const agents = agentOrder.map((k) => agentMap.get(k)!.info);
		return { agentSections: sections, allAgents: agents };
	}, [allEvents]);

	// Filter toggle handler
	function handleFilterToggle(name: string) {
		setActiveFilters((prev) => {
			if (name === "__all__") return new Set(); // clear = show all
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	}

	// Filter by selected agent from tree panel
	const visibleSections = React.useMemo(() => {
		if (!selectedAgentId) return agentSections;
		return agentSections.filter((section) => {
			const sectionAgentId = section.messages[0]?.agent_id ?? section.toolCalls[0]?.agent_id ?? section.otherEvents[0]?.agent_id;
			if (!sectionAgentId) return false;
			if (sectionAgentId === selectedAgentId) return true;
			// Show workers under a selected lead (parent_id match)
			const spawnEvt = section.otherEvents.find((e) => e.event_type === "agent_spawn");
			return spawnEvt?.data?.parent_id === selectedAgentId;
		});
	}, [agentSections, selectedAgentId]);

	// Derive session status from SSE events — prefer session_state if available
	const latestSessionState = React.useMemo(() => {
		for (let i = liveEvents.length - 1; i >= 0; i--) {
			if (liveEvents[i]!.event_type === "session_state") return liveEvents[i]!;
		}
		return null;
	}, [liveEvents]);

	const sessionStatus = React.useMemo(() => deriveSessionStatus(allEvents, "active"), [allEvents]);

	return (
		<div className="flex flex-col h-full min-h-0">
			{streamError && (
				<p className="text-xs text-amber-400 px-3 py-1.5 bg-amber-950/30 border-b border-amber-900/40">
					{streamError}
				</p>
			)}

			{latestSessionState && <SessionStatusBar event={latestSessionState} />}

			{/* Agent filter indicator */}
			{selectedAgentId && (
				<div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-950/30 border-b border-cyan-900/40 text-xs">
					<span className="text-cyan-400">Filtered to agent: {selectedAgentId}</span>
					<button
						className="text-cyan-300 hover:text-white transition-colors"
						onClick={onClearFilter}
					>
						Clear
					</button>
				</div>
			)}

			<div className="relative flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
				<div className="p-3">
					{allEvents.length === 0 && (
						<div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
							Waiting for events…
						</div>
					)}

					{/* Per-agent grouped sections */}
					{visibleSections.map((section, i) => (
						<AgentSectionBlock
							key={`agent-${section.info.name}-${i}`}
							section={section}
						/>
					))}

					<div ref={bottomRef} />
				</div>
				{!autoFollow && (
					<button
						className="sticky bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-cyan-600/80 hover:bg-cyan-600 text-white text-xs shadow-lg transition-colors z-10 flex items-center gap-1"
						onClick={() => {
							setAutoFollow(true);
							bottomRef.current?.scrollIntoView({ behavior: "smooth" });
						}}
					>
						↓ Follow
					</button>
				)}
			</div>
			<div className="border-t border-zinc-800 p-3 space-y-2">
				{sendError && <p className="text-xs text-red-400">{sendError}</p>}
				{steerEvents.length > 0 && (
					<div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-cyan-500/20 bg-cyan-950/10 p-2">
						<div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-400/80">
							Steer conversation
						</div>
						{steerEvents.map((ev) => (
							<div key={`${ev.timestamp}-${ev.agent_id}-${ev.data?.message_id ?? ev.data?.ack_for ?? ev.data?.content}`} className="text-xs leading-snug">
								<span className={cn("font-semibold", ev.agent_id === "user" || ev.data?.from === "user" ? "text-cyan-300" : "text-emerald-300")}>
									{ev.agent_id === "user" || ev.data?.from === "user" ? "You" : String(ev.data?.from ?? ev.agent_id)}
								</span>
								<span className="text-zinc-600"> → {formatSteerPeer(ev)}: </span>
								<span className="text-zinc-300">{String(ev.data?.content ?? ev.data?.ack_for ?? "ack")}</span>
							</div>
						))}
					</div>
				)}
				{pendingAckId && (
					<p className={cn("text-xs", ackEvent ? "text-emerald-400" : "text-zinc-500")}>
						{ackEvent ? "Orchestrator ACK received" : "Steer sent; waiting for Orchestrator ACK"}
					</p>
				)}
				{/* Session control buttons */}
				{sessionStatus !== "completed" && (
					<div className="flex items-center gap-2">
						{sessionStatus === "active" ? (
							<button
								className="px-2.5 py-1 rounded text-xs bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors"
								onClick={() => api.sendMessage(sessionId, "!pause")}
							>
								⏸ Pause
							</button>
						) : sessionStatus === "paused" ? (
							<button
								className="px-2.5 py-1 rounded text-xs bg-green-500/15 text-green-400 hover:bg-green-500/25 transition-colors"
								onClick={() => api.sendMessage(sessionId, "!resume")}
							>
								▶ Resume
							</button>
						) : null}
						<button
							className="px-2.5 py-1 rounded text-xs bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
							onClick={() => api.sendMessage(sessionId, "!stop")}
						>
							■ Stop
						</button>
						<Badge variant="outline" className="text-xs ml-auto">
							{sessionStatus}
						</Badge>
					</div>
				)}
				<div className="flex gap-2">
					<input
						className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-cyan-500"
						placeholder={selectedAgentId ? `Message ${selectedAgentId}…` : "Steer the orchestrator…"}
						value={message}
						onChange={(e) => onMessageChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") onSend();
						}}
					/>
					<Button size="sm" onClick={onSend} disabled={!message.trim()}>
						Send
					</Button>
				</div>
			</div>
		</div>
	);
}

// ─── Cost tab ─────────────────────────────────────────────────────────────────

function CostTab({ sessionId }: { sessionId: string }) {
	const {
		data: pgAgents,
		loading: agentsLoading,
		error: agentsError,
	} = usePolling((signal) => api.sessionAgents(sessionId, signal), 15_000, [
		sessionId,
	]);

	const {
		data: events,
		loading: eventsLoading,
		error: eventsError,
	} = usePolling((signal) => api.sessionEvents(sessionId, signal), 15_000, [
		sessionId,
	]);

	const loading = agentsLoading || eventsLoading;
	const error = agentsError || eventsError;

	// Merge PG agents with event-reconstructed agents for full cost data
	const agents = React.useMemo(() => {
		const fromEvents = buildAgentsFromEvents(events ?? []);
		return mergeAgents(pgAgents ?? [], fromEvents);
	}, [pgAgents, events]);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
				Loading cost data…
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex items-center justify-center h-32 text-red-400 text-sm">
				{error}
			</div>
		);
	}

	return <CostBreakdown agents={agents} />;
}

// ─── Main SessionTabs component ───────────────────────────────────────────────

interface SessionTabsProps {
	session: DBSession;
	historyEvents: DBEvent[];
	onRefresh: () => void;
	selectedAgentId?: string | null;
	onClearAgentFilter?: () => void;
}

export function SessionTabs({
	session,
	historyEvents,
	onRefresh,
	selectedAgentId,
	onClearAgentFilter,
}: SessionTabsProps) {
	const [tab, setTab] = React.useState("stream");
	const [message, setMessage] = React.useState("");
	const [sendError, setSendError] = React.useState<string | null>(null);
	const [pendingAckId, setPendingAckId] = React.useState<string | null>(null);

	// Use shared SSE from context
	const { events: liveEvents, error: streamError } = useSessionSSE();

	const mergedEvents = React.useMemo(() => mergeSessionEvents(historyEvents, liveEvents), [historyEvents, liveEvents]);
	const displayStatus = React.useMemo(() => deriveSessionStatus(mergedEvents, session.status), [mergedEvents, session.status]);

	const totals = React.useMemo(() => {
		const duration = session.completed_at
			? new Date(session.completed_at).getTime() -
				new Date(session.created_at).getTime()
			: Date.now() - new Date(session.created_at).getTime();
		return { duration };
	}, [session]);

	async function handleSend() {
		if (!message.trim()) return;
		setSendError(null);
		try {
			const result = await api.sendMessage(session.id, message.trim(), { targetAgentId: selectedAgentId });
			setPendingAckId(result.message_id);
			setMessage("");
		} catch (err) {
			setSendError(
				err instanceof Error ? err.message : "Failed to send message",
			);
		}
	}

	return (
		<main className="min-w-0 flex-1 overflow-hidden flex flex-col">
			{/* Session header */}
			<div className="border-b border-white/10 bg-slate-950/60 px-4 py-3 md:px-6 shrink-0">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="text-xl font-bold text-zinc-100 break-words">
								{session.name}
							</h2>
							<Badge className={statusColor(displayStatus)} variant="outline">
								{displayStatus}
							</Badge>
							{session.chain && (
								<Badge variant="secondary">{session.chain}</Badge>
							)}
						</div>
						<p className="mt-0.5 text-xs text-slate-500">
							{shortId(session.id)} · {session.platform} ·{" "}
							{new Date(session.created_at).toLocaleString()} ·{" "}
							{formatDurationMs(totals.duration)}
						</p>
					</div>
					<Button variant="outline" size="sm" onClick={onRefresh}>
						<RefreshCw className="w-3.5 h-3.5" />
						Refresh
					</Button>
				</div>
			</div>

			{/* Tabs */}
			<div className="flex-1 min-h-0 flex flex-col p-4 md:p-6 gap-3 overflow-auto">
				<Tabs
					value={tab}
					onValueChange={setTab}
					className="flex flex-col flex-1 min-h-0"
				>
					<TabsList className="shrink-0 self-start">
						<TabsTrigger value="stream">
							<MessageSquare className="w-3.5 h-3.5 mr-1.5" />
							Stream
						</TabsTrigger>
						<TabsTrigger value="agents">
							<Bot className="w-3.5 h-3.5 mr-1.5" />
							Agents
						</TabsTrigger>
						<TabsTrigger value="board">
							<Columns3 className="w-3.5 h-3.5 mr-1.5" />
							Board
						</TabsTrigger>
						<TabsTrigger value="tilldone">
							<CheckSquare className="w-3.5 h-3.5 mr-1.5" />
							Progress
						</TabsTrigger>
						<TabsTrigger value="files">
							<FolderOpen className="w-3.5 h-3.5 mr-1.5" />
							Files
						</TabsTrigger>
						<TabsTrigger value="cost">
							<DollarSign className="w-3.5 h-3.5 mr-1.5" />
							Cost
						</TabsTrigger>
						<TabsTrigger value="replay">
							<PlayCircle className="w-3.5 h-3.5 mr-1.5" />
							Replay
						</TabsTrigger>
					</TabsList>

					{/* Stream tab */}
					<TabsContent value="stream" className="flex-1 min-h-0">
						<Card
							className="glass flex flex-col h-full"
							style={{ minHeight: "calc(100vh - 280px)" }}
						>
							<CardHeader className="py-3 px-4 shrink-0 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<Activity className="w-4 h-4 text-cyan-400" />
									Live event stream
									<span className="ml-auto text-xs text-zinc-500 font-normal">
										{liveEvents.length} live · {historyEvents.length} historical
									</span>
								</CardTitle>
							</CardHeader>
							<CardContent className="flex-1 min-h-0 p-0">
								<StreamTab
									sessionId={session.id}
									liveEvents={liveEvents}
									historyEvents={historyEvents}
									streamError={streamError}
									message={message}
									sendError={sendError}
									pendingAckId={pendingAckId}
									onMessageChange={setMessage}
									onSend={() => void handleSend()}
									selectedAgentId={selectedAgentId}
									onClearFilter={onClearAgentFilter}
								/>
							</CardContent>
						</Card>
					</TabsContent>

					{/* Agents tab */}
					<TabsContent value="agents" className="flex-1 min-h-0">
						<Card className="glass">
							<CardHeader className="py-3 px-4 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<Bot className="w-4 h-4 text-cyan-400" />
									Agent graph
								</CardTitle>
							</CardHeader>
							<CardContent className="p-4">
								<AgentGraph sessionId={session.id} events={historyEvents} />
							</CardContent>
						</Card>
					</TabsContent>

					{/* Board tab */}
					<TabsContent value="board" className="flex-1 min-h-0">
						<Card className="glass">
							<CardHeader className="py-3 px-4 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<Columns3 className="w-4 h-4 text-cyan-400" />
									Board
								</CardTitle>
							</CardHeader>
							<CardContent className="p-4">
								<BoardTab session={session} historyEvents={historyEvents} liveEvents={liveEvents} />
							</CardContent>
						</Card>
					</TabsContent>

					{/* TillDone / Progress tab */}
					<TabsContent value="tilldone" className="flex-1 min-h-0">
						<Card className="glass">
							<CardHeader className="py-3 px-4 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<CheckSquare className="w-4 h-4 text-cyan-400" />
									Till-done progress
								</CardTitle>
							</CardHeader>
							<CardContent className="p-4">
								<TillDone sessionId={session.id} />
							</CardContent>
						</Card>
					</TabsContent>

					{/* Files tab */}
					<TabsContent value="files" className="flex-1 min-h-0">
						<Card className="glass">
							<CardHeader className="py-3 px-4 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<FolderOpen className="w-4 h-4 text-cyan-400" />
									Files changed
								</CardTitle>
							</CardHeader>
							<CardContent className="p-4">
								<FilesView sessionId={session.id} />
							</CardContent>
						</Card>
					</TabsContent>

					{/* Cost tab */}
					<TabsContent value="cost" className="flex-1 min-h-0">
						<Card className="glass">
							<CardHeader className="py-3 px-4 border-b border-white/5">
								<CardTitle className="flex items-center gap-2 text-sm">
									<DollarSign className="w-4 h-4 text-cyan-400" />
									Cost breakdown
								</CardTitle>
							</CardHeader>
							<CardContent className="p-4">
								<CostTab sessionId={session.id} />
							</CardContent>
						</Card>
					</TabsContent>

					{/* Replay tab */}
					<TabsContent value="replay" className="flex-1 min-h-0">
						<ReplayPlayer sessionId={session.id} />
					</TabsContent>
				</Tabs>
			</div>
		</main>
	);
}
