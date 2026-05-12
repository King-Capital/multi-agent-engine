import { randomUUID } from "crypto";
import { join } from "path";
import { getChain, loadPrompt, loadTeams, loadPersona, resolveModelForRole, loadModelRouting } from "./config";
import { EventEmitter } from "./event-emitter";
import { createLogger, addSink, flushSinks } from "./logger";
import { createLangfuseSink } from "./langfuse-sink";
import { createTraceRecorder, TRACE_DIR } from "./trace-recorder";
import { sanitizeAgentInput } from "./security";

if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  addSink(createLangfuseSink({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    host: process.env.LANGFUSE_HOST ?? "http://localhost:3000",
  }));
}

// JSONL trace recorder -- always active, one file per session
addSink(createTraceRecorder());
import { PipelineTracker } from "./pipeline-state";
import { SandboxPool } from "./sandbox-pool";
import { trackActivity, trackToolCall, untrackActivity } from "./monitoring";
import type { AgentActivity } from "./monitoring";
import { ActiveMonitor } from "./active-monitor";
import { loadBudgets, checkBudget } from "./budget";
import type { BudgetState } from "./budget";
import { sendUserMessage, listenForUserMessages, stopListening } from "./messaging";
import { OrchestratorLoop } from "./orchestrator-loop";
import { ConcurrencyLimiter } from "./concurrency";

// Extracted chain-runner module
import {
  runChain,
  buildTillDone,
  interpolatePrompt,
} from "./chain-runner";
import type { ChainRunnerDeps } from "./chain-runner";

import type {
  PlatformAdapter,
  SessionState,
  OrchestratorAction,
} from "./types";
import { transitionStatus } from "./session-state";

const log = createLogger("orchestrator");

export class Orchestrator {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private defaultAdapter: string = "";
  private emitter: EventEmitter;
  private dashboardUrl: string;
  private sessions: Map<string, SessionState> = new Map();
  private agentActivity: Map<string, AgentActivity> = new Map();
  private activeMonitor: ActiveMonitor | null = null;
  private messageSenders: Map<string, (msg: string) => void> = new Map();
  private pipelines: Map<string, PipelineTracker> = new Map();
  private sandboxPool: SandboxPool | null = null;
  private sseAbort: AbortController | null = null;
  private budgetState: BudgetState = { budgets: null, budgetWarned: false };
  private pausedSessions = new Set<string>();
  private messageBuffers = new Map<string, string[]>();
  private actionQueues = new Map<string, OrchestratorAction[]>();
  private skippedSteps = new Set<number>();
  private originalStepCount = 0;
  private orchestratorLoop: OrchestratorLoop | null = null;

  constructor(dashboardUrl?: string, apiToken?: string) {
    this.dashboardUrl = dashboardUrl ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400";
    this.emitter = new EventEmitter(dashboardUrl, apiToken);
  }

  enableSandboxPool(opts?: { pveApi?: string; pveToken?: string; poolSize?: number }): void {
    this.sandboxPool = new SandboxPool(opts);
    log.info("Sandbox pool enabled", { total: this.sandboxPool.status().total });
  }

  async shutdown(): Promise<void> {
    log.info("Shutting down");
    for (const [id, session] of this.sessions) {
      if (session.status === "active" || session.status === "paused") {
        transitionStatus(session, "error", "orchestrator:shutdown");
        this.activeMonitor?.stop();
        stopListening(this.sseAbort);
        await this.emitter.sessionEnd(id, session.status);
      }
    }
    this.sessions.clear();
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.name, adapter);
    if (!this.defaultAdapter) {
      this.defaultAdapter = adapter.name;
    }
  }

  setDefaultAdapter(name: string): void {
    if (!this.adapters.has(name)) {
      throw new Error(`Adapter not registered: ${name}`);
    }
    this.defaultAdapter = name;
  }

  sendUserMessage(sessionId: string, message: string, messageId?: string): void {
    if (message.startsWith("!")) {
      const parts = message.slice(1).split(/\s+/);
      const cmd = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      this.handleSteerCommand(sessionId, cmd, args);
      return;
    }
    const ackMetadata = messageId ? { ack_for: messageId } : {};
    void this.emitter.message(sessionId, "orch-1", "Orchestrator", "user", "ACK: received steer message.", ackMetadata);
    if (this.orchestratorLoop) {
      void this.orchestratorLoop.handleUserMessage(message).catch(err =>
        log.error("Loop handleUserMessage failed", { error: err instanceof Error ? err.message : String(err) }));
    }
    const buf = this.messageBuffers.get(sessionId) ?? [];
    buf.push(message);
    this.messageBuffers.set(sessionId, buf);
    sendUserMessage(this.messageSenders, sessionId, message);
  }

  private async handleSteerCommand(sessionId: string, command: string, args: string): Promise<void> {
    const ts = new Date().toISOString();
    const emit = (type: string, msg: string) =>
      Promise.all([
        this.emitter.message(sessionId, "orch-1", "Orchestrator", "user", msg),
        this.emitter.emit({ session_id: sessionId, agent_id: "orch-1", event_type: type, timestamp: ts, data: {} }),
      ]);
    switch (command) {
      case "pause": {
        this.pausedSessions.add(sessionId);
        const session = this.sessions.get(sessionId);
        if (session && transitionStatus(session, "paused", "orchestrator:!pause")) {
          await this.emitter.pgUpdateSession(sessionId, { status: "paused" });
        }
        await emit("pause", "Session paused. Running agents will finish current work. Send !resume to continue.");
        break;
      }
      case "resume": {
        this.pausedSessions.delete(sessionId);
        const session = this.sessions.get(sessionId);
        if (session && transitionStatus(session, "active", "orchestrator:!resume")) {
          await this.emitter.pgUpdateSession(sessionId, { status: "active" });
        }
        await emit("resume", "Session resumed.");
        break;
      }
      case "stop": {
        const session = this.sessions.get(sessionId);
        if (session) transitionStatus(session, "error", "orchestrator:!stop");
        this.pausedSessions.delete(sessionId);
        await emit("session_end", "Session stopped by user.");
        break;
      }
      case "budget": {
        const newBudget = parseFloat(args);
        if (!isNaN(newBudget) && this.budgetState?.budgets) {
          this.budgetState.budgets.max_per_session_usd = newBudget;
          await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user", `Budget updated to $${newBudget}.`);
        }
        break;
      }
      default:
        await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
          `Unknown command: !${command}. Available: !pause, !resume, !stop, !budget <amount>`);
    }
    log.info("Steer command received", { session_id: sessionId, command });
  }

  private drainMessageBuffer(sessionId: string): string {
    const buf = this.messageBuffers.get(sessionId);
    if (!buf?.length) return "";
    const messages = buf.splice(0);
    return `\n\n**Steer messages from user:**\n${messages.map(m => `> ${m}`).join("\n")}`;
  }

  async resume(sessionId: string, opts?: { adapter?: string }): Promise<SessionState | null> {
    const pipeline = PipelineTracker.resume(sessionId);
    if (!pipeline) { log.error("No pipeline state for session", { session_id: sessionId }); return null; }
    const state = pipeline.getState();
    const nextStage = state.stages.findIndex(s => s.status === "pending" || s.status === "failed");
    if (nextStage === -1) { log.info("All stages complete"); return null; }
    log.info("Resuming session", { session_id: sessionId, stage: nextStage, stage_name: state.stages[nextStage]?.name });
    return this.run({ task: state.task, chain: state.chain, adapter: opts?.adapter, sessionName: `${state.name} (resumed)` });
  }

  async run(opts: {
    prompt?: string;
    chain?: string;
    task: string;
    args?: string[];
    adapter?: string;
    sessionName?: string;
    workingDir?: string;
  }): Promise<SessionState> {
    const sessionId = randomUUID();
    let chainName: string;
    let taskBody: string;

    if (opts.prompt) {
      const { config, body } = loadPrompt(opts.prompt);
      chainName = config.chain ?? "plan-build-review";
      taskBody = interpolatePrompt(body, opts.args ?? []);
    } else {
      chainName = opts.chain ?? "plan-build-review";
      taskBody = opts.task;
    }

    // Sanitize task input to strip prompt injection patterns (#45)
    taskBody = sanitizeAgentInput(taskBody);

    const chain = getChain(chainName);
    const taskSummary = (taskBody.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 50).trim();
    const sessionName = opts.sessionName ?? `${taskSummary || chainName}`;

    const session: SessionState = {
      id: sessionId,
      name: sessionName,
      chain: chainName,
      task: taskBody,
      workingDir: opts.workingDir ?? process.cwd(),
      status: "active",
      agents: new Map(),
      tillDone: buildTillDone(chain),
      events: [],
      totalCost: 0,
      totalTokens: 0,
      startedAt: new Date(),
    };
    this.sessions.set(sessionId, session);

    // Create pipeline state tracker for checkpoint/resume
    const pipeline = new PipelineTracker(sessionId, sessionName, chainName, taskBody);
    this.pipelines.set(sessionId, pipeline);

    // Task 4 fix: use sanitized taskBody instead of raw opts.task
    await this.emitter.sessionStart(sessionId, sessionName, chainName, taskBody);
    await this.emitter.pgCreateSession({ id: sessionId, name: sessionName, chain: chainName, team: chainName });

    const teams = loadTeams();
    const orchPersona = loadPersona(teams.orchestrator.path);
    const orchResolved = resolveModelForRole("orchestrator", teams.orchestrator.model);
    await this.emitter.agentSpawn(sessionId, "orch-1", "", orchPersona.name, "orchestrator", orchResolved.model, "Orchestration", teams.orchestrator.color ?? "#36f9f6");
    log.info("Session started", { session_id: sessionId, name: sessionName, chain: chainName, dashboard: `${this.dashboardUrl}/session/${sessionId}`, task: opts.task?.slice(0, 200) });
    log.info("Trace file", { session_id: sessionId, path: join(TRACE_DIR, `${sessionId}.jsonl`) });

    this.budgetState = loadBudgets();
    await this.emitter.tillDone(sessionId, sessionName, session.tillDone);
    this.activeMonitor = new ActiveMonitor({
      agentActivity: this.agentActivity, session, budgetState: this.budgetState,
      emitter: this.emitter, messageSenders: this.messageSenders,
      onAutoPause: (reason) => { this.pausedSessions.add(sessionId); transitionStatus(session, "paused", `orchestrator:auto-pause:${reason}`); log.warn("Auto-paused", { session_id: sessionId, reason }); },
      getAdapter: () => this.getAdapter(),
    });
    this.activeMonitor.start();
    const actionQueue: OrchestratorAction[] = [];
    this.actionQueues.set(sessionId, actionQueue);
    this.orchestratorLoop = new OrchestratorLoop({
      session, adapter: this.getAdapter(opts.adapter), emitter: this.emitter,
      budgetState: this.budgetState, pausedSessions: this.pausedSessions,
      messageBuffers: this.messageBuffers, actionQueue,
    });
    this.orchestratorLoop.start();
    this.sseAbort = listenForUserMessages(this.dashboardUrl, sessionId, (sid, content, messageId) => this.sendUserMessage(sid, content, messageId));

    this.skippedSteps.clear();
    const chainRunnerDeps = this.buildChainRunnerDeps();
    try {
      await runChain(chainRunnerDeps, session, chain, taskBody, opts.adapter);
      transitionStatus(session, "completed", "orchestrator:run");
      pipeline?.complete();
    } catch (err) {
      transitionStatus(session, "error", "orchestrator:run:catch");
      pipeline?.fail(String(err));
      log.error("Session failed", { session_id: sessionId, error: err instanceof Error ? err.message : String(err) });
      await this.emitter.pgUpdateSession(sessionId, { status: "failed" });
    }

    this.activeMonitor?.stop();
    this.activeMonitor = null;
    const orchCost = await this.orchestratorLoop?.stopAndDrain();
    if (orchCost) {
      await this.emitter.agentDone(
        sessionId,
        "orch-1",
        session.status === "completed" ? "VERIFIED" : "FAILED",
        orchCost.costUsd,
      );
    }
    this.orchestratorLoop = null;
    this.actionQueues.delete(sessionId);
    await this.emitter.sessionEnd(sessionId, session.status);
    stopListening(this.sseAbort);
    this.sseAbort = null;
    const prefix = `${sessionId}:`;
    for (const key of this.messageSenders.keys()) {
      if (key.startsWith(prefix)) this.messageSenders.delete(key);
    }
    log.info("Session ended", { session_id: sessionId, status: session.status, cost_usd: session.totalCost });
    await flushSinks();
    return session;
  }

  private buildChainRunnerDeps(): ChainRunnerDeps {
    return {
      emitter: this.emitter, messageSenders: this.messageSenders,
      agentActivity: this.agentActivity, budgetState: this.budgetState,
      pausedSessions: this.pausedSessions, messageBuffers: this.messageBuffers,
      actionQueues: this.actionQueues, skippedSteps: this.skippedSteps,
      originalStepCount: this.originalStepCount, pipelines: this.pipelines,
      orchestratorLoop: this.orchestratorLoop,
      getAdapter: (name?: string) => this.getAdapter(name),
      buildTeamDeps: () => this.buildTeamDeps(),
      drainMessageBuffer: (sid: string) => this.drainMessageBuffer(sid),
    };
  }

  private buildTeamDeps() {
    const routing = loadModelRouting();
    const concurrency = routing.concurrency;
    const sessionLimiter = concurrency?.max_concurrent_agents
      ? new ConcurrencyLimiter(concurrency.max_concurrent_agents)
      : undefined;

    return {
      emitter: this.emitter, messageSenders: this.messageSenders,
      trackActivity: (agentId: string, name: string, role: string) => trackActivity(this.agentActivity, agentId, name, role),
      untrackActivity: (agentId: string) => untrackActivity(this.agentActivity, agentId),
      trackToolCall: (agentId: string, tool: string) => trackToolCall(this.agentActivity, agentId, tool),
      checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => checkBudget(this.budgetState, session, agentId, agentCost, agentTokens, this.emitter),
      getAdapter: (name?: string) => this.getAdapter(name),
      orchestratorLoop: this.orchestratorLoop,
      pausedSessions: this.pausedSessions,
      sessionLimiter,
      teamLimiterMax: concurrency?.max_concurrent_per_team,
    };
  }

  private getAdapter(name?: string): PlatformAdapter {
    const adapterName = name ?? this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) throw new Error(`No adapter: ${adapterName}. Available: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }
}
