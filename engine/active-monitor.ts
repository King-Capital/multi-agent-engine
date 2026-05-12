import type { AgentActivity } from "./monitoring";
import { IDLE_WARN_MS, MONITOR_INTERVAL_MS } from "./monitoring";
import type { EventEmitter } from "./event-emitter";
import type { BudgetState } from "./budget";
import { checkBudgetProactive } from "./budget";
import type { SessionState, PlatformAdapter } from "./types";
import { createNudgeState, executeNudge, type NudgeState } from "./nudge";
import { createLogger } from "./logger";

const log = createLogger("active-monitor");

export interface ActiveMonitorOpts {
  agentActivity: Map<string, AgentActivity>;
  session: SessionState;
  budgetState: BudgetState;
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  onAutoPause: (reason: string) => void;
  getAdapter?: () => PlatformAdapter;
  intervalMs?: number;
}

export class ActiveMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private nudgeStates = new Map<string, NudgeState>();
  private llmNudgeInFlight = false;
  private autoPauseFired = false;
  private tick = 0;
  private readonly opts: ActiveMonitorOpts;

  constructor(opts: ActiveMonitorOpts) {
    this.opts = opts;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.onTick(), this.opts.intervalMs ?? MONITOR_INTERVAL_MS);
  }

  /** Exposed for testing — runs one monitor cycle synchronously. */
  runTick(): void {
    this.onTick();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.nudgeStates.clear();
    this.opts.agentActivity.clear();
  }

  private onTick(): void {
    this.tick++;
    this.checkStalls();
    this.checkBudgetProjection();
  }

  private checkStalls(): void {
    const now = Date.now();
    const isHeartbeat = this.tick % 2 === 0;

    for (const [id, activity] of this.opts.agentActivity) {
      const idle = now - activity.lastEventAt;

      if (isHeartbeat) {
        const status = idle > IDLE_WARN_MS ? "idle" : "working";
        log.debug("Heartbeat", {
          agent_id: id,
          agent_name: activity.name,
          role: activity.role,
          status,
          tool_calls: activity.toolCalls,
          last_tool: activity.lastTool || "none",
          idle_s: Math.round(idle / 1000),
          session_id: this.opts.session.id,
        });
      }

      if (idle <= IDLE_WARN_MS) {
        if (this.nudgeStates.has(id)) {
          this.nudgeStates.delete(id);
        }
        activity.warned = false;
        continue;
      }

      if (!activity.warned) {
        activity.warned = true;
        log.warn("Agent stall detected", {
          agent_id: id,
          agent_name: activity.name,
          idle_s: Math.round(idle / 1000),
          session_id: this.opts.session.id,
        });
        this.opts.emitter.stallDetected(
          this.opts.session.id,
          id,
          activity.name,
          Math.round(idle / 1000),
        );
      }

      if (!this.llmNudgeInFlight) {
        this.triggerNudge(id, activity);
      }
    }
  }

  private triggerNudge(agentId: string, activity: AgentActivity): void {
    if (!this.nudgeStates.has(agentId)) {
      this.nudgeStates.set(agentId, createNudgeState(agentId));
    }
    const state = this.nudgeStates.get(agentId)!;

    const needsLLM = state.nudgeCount >= 3;
    if (needsLLM) this.llmNudgeInFlight = true;

    const sender = this.opts.messageSenders.get(
      `${this.opts.session.id}:${agentId}`,
    );
    const allowLlmNudges = process.env.MAE_ENABLE_LLM_NUDGES === "1"
      || process.env.MAE_ENABLE_LLM_NUDGES === "true";
    const adapter = allowLlmNudges ? this.opts.getAdapter?.() : undefined;

    executeNudge(
      state,
      activity,
      this.opts.session,
      this.opts.emitter,
      sender,
      adapter,
    )
      .catch((err) => {
        log.error("Nudge failed", { agent_id: agentId, agent_name: activity.name, error: String(err), session_id: this.opts.session.id });
      })
      .finally(() => {
        if (needsLLM) this.llmNudgeInFlight = false;
      });
  }

  private checkBudgetProjection(): void {
    if (this.autoPauseFired) return;

    const { shouldPause } = checkBudgetProactive(
      this.opts.budgetState,
      this.opts.session,
      this.opts.emitter,
    );

    if (shouldPause) {
      this.autoPauseFired = true;
      log.warn("Budget threshold exceeded -- auto-pausing session", { session_id: this.opts.session.id });
      this.opts.emitter.autoPause(this.opts.session.id, "budget");
      this.opts.onAutoPause("budget");
    }
  }
}
