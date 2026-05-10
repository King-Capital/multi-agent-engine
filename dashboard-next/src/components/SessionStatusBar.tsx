import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LiveEvent } from "@/lib/types";

interface SessionStatusBarProps {
	event: LiveEvent;
}

const phaseColors: Record<string, string> = {
	planning: "bg-blue-500/15 text-blue-400 border-blue-500/30",
	building: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
	reviewing: "bg-amber-500/15 text-amber-400 border-amber-500/30",
	executing: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
	paused: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
	completed: "bg-green-500/15 text-green-400 border-green-500/30",
};

export function SessionStatusBar({ event }: SessionStatusBarProps) {
	const d = event.data;
	if (!d) return null;

	const phase = d.phase ?? "executing";
	const progress = d.progress ?? 0;
	const assessment = d.assessment ?? "";
	const activeLeads = d.active_leads ?? [];
	const currentStep = d.current_step ?? 0;
	const totalSteps = d.total_steps ?? 0;
	const budgetPercent = d.budget_percent ?? 0;

	return (
		<div className="border-b border-zinc-800 bg-zinc-900/50 px-3 py-2 space-y-1.5">
			<div className="flex items-center gap-2 flex-wrap">
				<Badge
					variant="outline"
					className={cn("text-[10px] uppercase tracking-wider", phaseColors[phase] ?? phaseColors.executing)}
				>
					{phase}
				</Badge>

				{totalSteps > 0 && (
					<span className="text-[10px] text-zinc-500">
						Step {currentStep + 1}/{totalSteps}
					</span>
				)}

				{activeLeads.length > 0 && (
					<span className="text-[10px] text-zinc-400">
						{activeLeads.join(", ")}
					</span>
				)}

				<div className="ml-auto flex items-center gap-2">
					{budgetPercent > 0 && (
						<span className={cn(
							"text-[10px]",
							budgetPercent > 80 ? "text-red-400" : budgetPercent > 50 ? "text-amber-400" : "text-zinc-500",
						)}>
							{budgetPercent.toFixed(0)}% budget
						</span>
					)}
				</div>
			</div>

			<div className="flex items-center gap-2">
				<div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
					<div
						className="h-full bg-cyan-500/60 rounded-full transition-all duration-500"
						style={{ width: `${Math.min(progress, 100)}%` }}
					/>
				</div>
				<span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">
					{progress.toFixed(0)}%
				</span>
			</div>

			{assessment && (
				<p className="text-[11px] text-zinc-400 leading-snug truncate" title={assessment}>
					{assessment}
				</p>
			)}
		</div>
	);
}
