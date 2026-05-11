import type {
  SessionState,
  SessionEvent,
  PlatformAdapter,
  OrchestratorAction,
  OrchestratorTrigger,
  PersonaConfig,
  ThinkingLevel,
  Chain,
} from "./types";
import type { EventEmitter } from "./event-emitter";
import type { BudgetState } from "./budget";
import { loadTeams, loadPersona, resolveModelForRole, buildSystemPrompt, getChain } from "./config";
import { sanitizeAgentInput } from "./security";
import { createLogger } from "./logger";

const log = createLogger("orchestrator-loop");

const ORCHESTRATOR_REASONING_PROMPT = `You are the orchestrator intelligence for a multi-agent coding session. You monitor progress, detect issues, and take corrective action.

## Context
You receive: current task, chain progress, recent events, and budget state.

## Available Actions
Respond with a JSON object containing your assessment and any actions to take:

- CONTINUE — Everything is on track, no intervention needed
- PAUSE — { type: "PAUSE", reason: "..." } — Pause to prevent waste or address an issue
- REASSIGN — { type: "REASSIGN", stepIndex: N, newTeam: "team-name", reason: "..." } — Change team for a future step
- SKIP_STEP — { type: "SKIP_STEP", stepIndex: N, reason: "..." } — Skip a step no longer needed
- SPAWN_TEAM — { type: "SPAWN_TEAM", team: "team-name", task: "...", reason: "..." } — Add an ad-hoc team
- ESCALATE_TO_USER — { type: "ESCALATE_TO_USER", message: "..." } — Ask the human for input

## Response Format (JSON only, no markdown fences)
{
  "assessment": "1-2 sentence status summary",
  "actions": [{ "type": "CONTINUE" }],
  "reply": null
}

Set "reply" to a string only when responding to a user message.

## Guidelines
- Default to CONTINUE unless there is a clear reason to intervene
- PAUSE when budget is critically low, agents are stuck in loops, or findings require human review
- REASSIGN only for future steps — you cannot interrupt a running step
- ESCALATE when the task is ambiguous and needs human clarification
- Keep assessments factual and concise`;

export interface OrchestratorLoopOpts {
  session: SessionState;
  adapter: PlatformAdapter;
  emitter: EventEmitter;
  budgetState: BudgetState;
  pausedSessions: Set<string>;
  messageBuffers: Map<string, string[]>;
  actionQueue: OrchestratorAction[];
  currentStepIndex?: number;
  intervalMs?: number;
}

interface CycleResult {
  assessment: string;
  actions: OrchestratorAction[];
  reply?: string;
}

const MAX_EVENTS = 50;
const DEBOUNCE_MS = 10_000;

export class OrchestratorLoop {
  private opts: OrchestratorLoopOpts;
  private recentEvents: SessionEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCycleAt = 0;
  private pendingTrigger: { reason: OrchestratorTrigger; context?: Record<string, unknown> } | null = null;
  private cycleInFlight = false;
  private _currentStepIndex: number;
  private _totalSteps: number;

  // Cached per-session values (never change during a session)
  private orchPersona: PersonaConfig | null = null;
  private orchModel: string = "quality";
  private orchThinking: ThinkingLevel = "medium";
  private orchSystemPrompt: string = ORCHESTRATOR_REASONING_PROMPT;
  private cachedChain: Chain | null = null;

  constructor(opts: OrchestratorLoopOpts) {
    this.opts = opts;
    this._currentStepIndex = opts.currentStepIndex ?? 0;
    try {
      this.cachedChain = getChain(opts.session.chain);
      this._totalSteps = this.cachedChain.steps?.length ?? 0;
    } catch {
      this._totalSteps = 0;
    }

    try {
      const teams = loadTeams();
      this.orchPersona = loadPersona(teams.orchestrator.path);
      const resolved = resolveModelForRole("orchestrator");
      this.orchModel = resolved.model;
      this.orchThinking = resolved.thinking;
      this.orchSystemPrompt = `${buildSystemPrompt(this.orchPersona, "orchestrator")}\n\n${ORCHESTRATOR_REASONING_PROMPT}`;
    } catch {
      this.orchPersona = null;
      this.orchModel = "quality";
      this.orchThinking = "medium";
      this.orchSystemPrompt = ORCHESTRATOR_REASONING_PROMPT;
    }
  }

  get currentStepIndex(): number {
    return this._currentStepIndex;
  }

  get totalSteps(): number {
    return this._totalSteps;
  }

  setCurrentStep(index: number, total: number): void {
    this._currentStepIndex = index;
    this._totalSteps = total;
  }

  start(): void {
    if (this.timer) return;
    const ms = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      if (this.pendingTrigger) {
        const { reason, context } = this.pendingTrigger;
        this.pendingTrigger = null;
        void this.runReasoningCycle(reason, context).catch(err => log.error("Periodic cycle failed", { trigger: reason, error: String(err), session_id: this.opts.session.id }));
      } else {
        void this.runReasoningCycle("periodic").catch(err => log.error("Periodic cycle failed", { trigger: "periodic", error: String(err), session_id: this.opts.session.id }));
      }
    }, ms);
    log.info("Started", { interval_ms: ms, session_id: this.opts.session.id });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("Stopped", { session_id: this.opts.session.id });
    }
  }

  trigger(reason: OrchestratorTrigger, context?: Record<string, unknown>): void {
    const elapsed = Date.now() - this.lastCycleAt;
    if (elapsed < DEBOUNCE_MS) {
      this.pendingTrigger = { reason, context };
      return;
    }
    void this.runReasoningCycle(reason, context).catch(err => log.error("Triggered cycle failed", { trigger: reason, error: String(err), session_id: this.opts.session.id }));
  }

  async handleUserMessage(msg: string): Promise<void> {
    await this.runReasoningCycle("user_message", { message: msg });
  }

  recordEvent(event: SessionEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_EVENTS) {
      this.recentEvents.shift();
    }
  }

  private async runReasoningCycle(
    trigger: OrchestratorTrigger,
    context?: Record<string, unknown>,
  ): Promise<void> {
    if (this.cycleInFlight) return;
    this.cycleInFlight = true;
    this.lastCycleAt = Date.now();

    try {
      const contextWindow = this.buildContextWindow(trigger, context);

      // Use cached persona/model/prompt (loaded once in constructor)
      if (!this.orchPersona) {
        log.error("No orchestrator persona loaded, skipping cycle", { session_id: this.opts.session.id });
        return;
      }

      const REASONING_TIMEOUT_MS = 90_000;
      const result = await Promise.race([
        this.opts.adapter.delegate({
          persona: this.orchPersona,
          systemPrompt: this.orchSystemPrompt,
          userPrompt: contextWindow,
          model: this.orchModel,
          thinking: this.orchThinking,
          tools: [],
          domain: { read: [], write: [], update: [] },
          workingDir: this.opts.session.workingDir,
          sessionDir: `data/sessions/${this.opts.session.id}`,
          parentId: "orch-1",
          teamName: "Orchestrator",
          teamColor: "#36f9f6",
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Orchestrator reasoning timeout")), REASONING_TIMEOUT_MS)),
      ]);

      const { assessment, actions, reply } = this.parseActions(result.output);

      for (const action of actions) {
        this.opts.actionQueue.push(action);
      }

      if (reply) {
        await this.opts.emitter.message(
          this.opts.session.id,
          "orch-1",
          "Orchestrator",
          "user",
          reply,
        );
      }

      await this.emitSessionState(assessment);

      this.opts.session.totalCost += result.costUsd;
      this.opts.session.totalTokens += result.tokensUsed;

      log.info("Cycle complete", {
        trigger,
        assessment,
        actions: actions.map((a) => a.type),
        session_id: this.opts.session.id,
      });
    } catch (err) {
      log.error("Cycle failed", { trigger, error: String(err), session_id: this.opts.session.id });
    } finally {
      this.cycleInFlight = false;
    }
  }

  private buildContextWindow(
    trigger: OrchestratorTrigger,
    context?: Record<string, unknown>,
  ): string {
    const session = this.opts.session;
    const sections: string[] = [];

    sections.push(`## Task\n${sanitizeAgentInput(session.task).slice(0, 500)}`);
    sections.push(`## Chain: ${session.chain}`);

    const tillDoneLines = session.tillDone
      .map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.description}`)
      .join("\n");
    sections.push(
      `## Progress\n${tillDoneLines}\nStep ${this._currentStepIndex}/${this._totalSteps}`,
    );

    let budgetLine = `$${session.totalCost.toFixed(3)} spent`;
    if (this.opts.budgetState.budgets) {
      budgetLine += ` / $${this.opts.budgetState.budgets.max_per_session_usd} limit`;
    }
    sections.push(`## Budget\n${budgetLine}`);

    sections.push(`## Session Status: ${session.status}`);

    const eventLines = this.recentEvents
      .map(
        (e) =>
          `[${e.timestamp}] ${e.event_type}: ${JSON.stringify(e.data).slice(0, 200)}`,
      )
      .join("\n");
    sections.push(
      `## Recent Events (last ${this.recentEvents.length})\n${eventLines}`,
    );

    if (trigger === "user_message" && context?.message) {
      sections.push(`## User Message\n${sanitizeAgentInput(String(context.message)).slice(0, 2000)}`);
    }

    return sections.join("\n\n");
  }

  private parseActions(output: string): CycleResult {
    try {
      const start = output.indexOf("{");
      const end = output.lastIndexOf("}");
      if (start === -1 || end === -1) {
        return { assessment: "Could not parse response", actions: [{ type: "CONTINUE" }] };
      }

      const json = JSON.parse(output.slice(start, end + 1)) as {
        assessment?: string;
        actions?: OrchestratorAction[];
        reply?: string;
      };

      const assessment = json.assessment ?? "No assessment provided";
      const reply = json.reply ?? undefined;
      const rawActions = json.actions ?? [{ type: "CONTINUE" }];

      const validActions: OrchestratorAction[] = [];
      for (const action of rawActions) {
        if (!action || typeof action !== "object" || !("type" in action)) continue;
        const a = action as Record<string, unknown>;
        const valid =
          a.type === "CONTINUE" ||
          (a.type === "PAUSE" && typeof a.reason === "string") ||
          (a.type === "REASSIGN" && typeof a.stepIndex === "number" && typeof a.newTeam === "string" && typeof a.reason === "string") ||
          (a.type === "SKIP_STEP" && typeof a.stepIndex === "number" && typeof a.reason === "string") ||
          (a.type === "SPAWN_TEAM" && typeof a.team === "string" && typeof a.task === "string" && typeof a.reason === "string") ||
          (a.type === "ESCALATE_TO_USER" && typeof a.message === "string");
        if (valid) validActions.push(action as OrchestratorAction);
      }

      if (validActions.length === 0) {
        validActions.push({ type: "CONTINUE" });
      }

      return { assessment, actions: validActions, reply };
    } catch {
      return { assessment: "Could not parse response", actions: [{ type: "CONTINUE" }] };
    }
  }

  private async emitSessionState(assessment: string): Promise<void> {
    await this.opts.emitter.sessionState(this.opts.session.id, {
      phase: this.computePhase(),
      active_leads: this.getActiveLeads(),
      progress: this.computeProgress(),
      current_step: this._currentStepIndex,
      total_steps: this._totalSteps,
      assessment,
      session_status: this.opts.session.status,
      budget_percent: this.computeBudgetPercent(),
      actions: this.computeAvailableActions(),
      last_updated: new Date().toISOString(),
    });
  }

  private computeProgress(): number {
    const done = this.opts.session.tillDone.filter((t) => t.completed).length;
    return (done / Math.max(this.opts.session.tillDone.length, 1)) * 100;
  }

  private computePhase(): string {
    const session = this.opts.session;
    if (session.status === "paused") return "paused";
    if (session.status === "completed") return "completed";

    if (!this.cachedChain) return "executing";

    const step = this.cachedChain.steps[this._currentStepIndex];
    if (!step) return "executing";

    const teamName = (step.team ?? "").toLowerCase();
    if (teamName.includes("plan")) return "planning";
    if (teamName.includes("engineer") || teamName.includes("build")) return "building";
    if (
      teamName.includes("review") ||
      teamName.includes("valid") ||
      teamName.includes("test") ||
      teamName.includes("red") ||
      teamName.includes("blue")
    )
      return "reviewing";

    return "executing";
  }

  private getActiveLeads(): string[] {
    const spawnedLeads = new Map<string, string>();
    const doneAgents = new Set<string>();

    for (const event of this.recentEvents) {
      if (
        event.event_type === "agent_spawn" &&
        (event.data as Record<string, unknown>).agent_role === "lead"
      ) {
        spawnedLeads.set(
          event.agent_id,
          (event.data as Record<string, unknown>).agent_name as string,
        );
      }
      if (event.event_type === "agent_done") {
        doneAgents.add(event.agent_id);
      }
    }

    const active: string[] = [];
    for (const [id, name] of spawnedLeads) {
      if (!doneAgents.has(id)) {
        active.push(name);
      }
    }
    return active;
  }

  private computeBudgetPercent(): number {
    if (!this.opts.budgetState.budgets) return 0;
    if (this.opts.budgetState.budgets.max_per_session_usd <= 0) return 0;
    return (
      (this.opts.session.totalCost /
        this.opts.budgetState.budgets.max_per_session_usd) *
      100
    );
  }

  private computeAvailableActions(): string[] {
    if (this.opts.session.status === "paused") return ["resume", "stop"];
    if (this.opts.session.status === "active") return ["pause", "stop"];
    return [];
  }
}
