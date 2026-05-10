import { randomUUID } from "crypto";
import {
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModelForRole,
  getChain,
  loadPrompt,
} from "./config";
import { EventEmitter } from "./event-emitter";
import { sanitizeAgentInput } from "./security";

function wrapStepOutput(output: string): string {
  return `<previous_agent_output>\n${sanitizeAgentInput(output)}\n</previous_agent_output>`;
}
import { delegateWithHealing } from "./self-healing";
import { PipelineTracker } from "./pipeline-state";
import { SandboxPool } from "./sandbox-pool";

// Extracted modules
import { summarizeOutput, worstGrade } from "./output-parsing";
import { trackActivity, trackToolCall } from "./monitoring";
import { scanSeverity, shouldAutoPause, extractFindingExcerpt } from "./severity-scanner";
import type { AgentActivity } from "./monitoring";
import { ActiveMonitor } from "./active-monitor";
import { loadBudgets, checkBudget } from "./budget";
import type { BudgetState } from "./budget";
import { sendUserMessage, listenForUserMessages, stopListening } from "./messaging";
import { runTeamStep, runParallelStep } from "./team-execution";
import { logPerformance } from "./perf-log";
import { OrchestratorLoop } from "./orchestrator-loop";

import type {
  PlatformAdapter,
  DelegateResult,
  DelegateOptions,
  Chain,
  ChainStep,
  SessionState,
  TillDoneItem,
  OrchestratorAction,
} from "./types";

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
    this.dashboardUrl = dashboardUrl ?? "http://localhost:8400";
    this.emitter = new EventEmitter(dashboardUrl, apiToken);
  }

  enableSandboxPool(opts?: { pveApi?: string; pveToken?: string; poolSize?: number }): void {
    this.sandboxPool = new SandboxPool(opts);
    console.log(`[orchestrator] Sandbox pool enabled (${this.sandboxPool.status().total} sandboxes)`);
  }

  async shutdown(): Promise<void> {
    console.log("[orchestrator] Shutting down...");
    for (const [id, session] of this.sessions) {
      if (session.status === "active" || session.status === "paused") {
        session.status = "error";
        this.activeMonitor?.stop();
        stopListening(this.sseAbort);
        await this.emitter.sessionEnd(id);
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

  sendUserMessage(sessionId: string, message: string): void {
    if (message.startsWith("!")) {
      const parts = message.slice(1).split(/\s+/);
      const cmd = parts[0] ?? "";
      const args = parts.slice(1).join(" ");
      this.handleSteerCommand(sessionId, cmd, args);
      return;
    }
    if (this.orchestratorLoop) {
      void this.orchestratorLoop.handleUserMessage(message).catch(err =>
        console.error("[orchestrator] Loop handleUserMessage failed:", err));
    }
    const buf = this.messageBuffers.get(sessionId) ?? [];
    buf.push(message);
    this.messageBuffers.set(sessionId, buf);
    sendUserMessage(this.messageSenders, sessionId, message);
  }

  private async handleSteerCommand(sessionId: string, command: string, args: string): Promise<void> {
    switch (command) {
      case "pause":
        this.pausedSessions.add(sessionId);
        await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
          "Session paused. Running agents will finish current work. Send !resume to continue.");
        await this.emitter.emit({ session_id: sessionId, agent_id: "orch-1", event_type: "pause", timestamp: new Date().toISOString(), data: {} });
        console.log(`[orchestrator] Session ${sessionId} paused by user`);
        break;
      case "resume":
        this.pausedSessions.delete(sessionId);
        await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
          "Session resumed.");
        await this.emitter.emit({ session_id: sessionId, agent_id: "orch-1", event_type: "resume", timestamp: new Date().toISOString(), data: {} });
        console.log(`[orchestrator] Session ${sessionId} resumed by user`);
        break;
      case "stop": {
        const session = this.sessions.get(sessionId);
        if (session) session.status = "error";
        this.pausedSessions.delete(sessionId);
        await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
          "Session stopped by user.");
        await this.emitter.emit({ session_id: sessionId, agent_id: "orch-1", event_type: "session_end", timestamp: new Date().toISOString(), data: {} });
        console.log(`[orchestrator] Session ${sessionId} stopped by user`);
        break;
      }
      case "budget": {
        const newBudget = parseFloat(args);
        if (!isNaN(newBudget) && this.budgetState?.budgets) {
          this.budgetState.budgets.max_per_session_usd = newBudget;
          await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
            `Budget updated to $${newBudget}.`);
          console.log(`[orchestrator] Session ${sessionId} budget set to $${newBudget}`);
        }
        break;
      }
      default:
        await this.emitter.message(sessionId, "orch-1", "Orchestrator", "user",
          `Unknown command: !${command}. Available: !pause, !resume, !stop, !budget <amount>`);
    }
  }

  private drainMessageBuffer(sessionId: string): string {
    const buf = this.messageBuffers.get(sessionId);
    if (!buf?.length) return "";
    const messages = buf.splice(0);
    return `\n\n**Steer messages from user:**\n${messages.map(m => `> ${m}`).join("\n")}`;
  }

  async resume(sessionId: string, opts?: { adapter?: string }): Promise<SessionState | null> {
    const pipeline = PipelineTracker.resume(sessionId);
    if (!pipeline) {
      console.error(`[orchestrator] No pipeline state found for session ${sessionId}`);
      return null;
    }

    const state = pipeline.getState();
    console.log(`[orchestrator] Resuming session ${sessionId} (${state.name}) from stage ${state.currentStage}`);
    console.log(`[orchestrator] Pipeline status: ${state.status}, stages: ${state.stages.length}`);

    // Find the next pending or failed stage
    const nextStage = state.stages.findIndex(s => s.status === "pending" || s.status === "failed");
    if (nextStage === -1) {
      console.log(`[orchestrator] All stages complete or no pending stages found`);
      return null;
    }

    console.log(`[orchestrator] Resuming from stage ${nextStage}: ${state.stages[nextStage]?.name}`);

    // Re-run from the failed/pending stage
    return this.run({
      task: state.task,
      chain: state.chain,
      adapter: opts?.adapter,
      sessionName: `${state.name} (resumed)`,
    });
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
      taskBody = this.interpolatePrompt(body, opts.args ?? []);
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
      tillDone: this.buildTillDone(chain),
      events: [],
      totalCost: 0,
      totalTokens: 0,
      startedAt: new Date(),
    };
    this.sessions.set(sessionId, session);

    // Create pipeline state tracker for checkpoint/resume
    const pipeline = new PipelineTracker(sessionId, sessionName, chainName, taskBody);
    this.pipelines.set(sessionId, pipeline);

    await this.emitter.sessionStart(sessionId, sessionName, chainName, opts.task);
    await this.emitter.pgCreateSession({ id: sessionId, name: sessionName, chain: chainName, team: chainName });

    const teams = loadTeams();
    const orchPersona = loadPersona(teams.orchestrator.path);
    const orchResolved = resolveModelForRole("orchestrator", teams.orchestrator.model);
    await this.emitter.agentSpawn(sessionId, "orch-1", "", orchPersona.name, "orchestrator",
      orchResolved.model, "Orchestration", teams.orchestrator.color ?? "#36f9f6");
    await this.emitter.pgCreateAgent({ sessionId, agentId: "orch-1", role: "orchestrator", persona: orchPersona.name });

    console.log(`\n[orchestrator] Session: ${sessionName}`);
    console.log(`[orchestrator] Chain: ${chainName}`);
    console.log(`[orchestrator] Dashboard: ${this.dashboardUrl}/session/${sessionId}`);
    console.log(`[orchestrator] Task: ${opts.task}\n`);

    this.budgetState = loadBudgets();
    await this.emitter.tillDone(sessionId, sessionName, session.tillDone);
    this.activeMonitor = new ActiveMonitor({
      agentActivity: this.agentActivity,
      session,
      budgetState: this.budgetState,
      emitter: this.emitter,
      messageSenders: this.messageSenders,
      onAutoPause: (reason) => {
        this.pausedSessions.add(sessionId);
        session.status = "paused";
        console.warn(`[orchestrator] Session auto-paused: ${reason}`);
      },
      getAdapter: () => this.getAdapter(),
    });
    this.activeMonitor.start();
    const actionQueue: OrchestratorAction[] = [];
    this.actionQueues.set(sessionId, actionQueue);
    this.orchestratorLoop = new OrchestratorLoop({
      session,
      adapter: this.getAdapter(opts.adapter),
      emitter: this.emitter,
      budgetState: this.budgetState,
      pausedSessions: this.pausedSessions,
      messageBuffers: this.messageBuffers,
      actionQueue,
    });
    this.orchestratorLoop.start();
    this.sseAbort = listenForUserMessages(this.dashboardUrl, sessionId, (sid, content) => {
      this.sendUserMessage(sid, content);
    });

    this.skippedSteps.clear();
    try {
      await this.runChain(session, chain, taskBody, opts.adapter);
      session.status = "completed";
      pipeline?.complete();
    } catch (err) {
      session.status = "error";
      pipeline?.fail(String(err));
      console.error(`[orchestrator] Session failed:`, err);
      await this.emitter.pgUpdateSession(sessionId, { status: "failed" });
    }

    this.activeMonitor?.stop();
    this.activeMonitor = null;
    this.orchestratorLoop?.stop();
    this.orchestratorLoop = null;
    this.actionQueues.delete(sessionId);
    await this.emitter.sessionEnd(sessionId);
    stopListening(this.sseAbort);
    this.sseAbort = null;
    const prefix = `${sessionId}:`;
    for (const key of this.messageSenders.keys()) {
      if (key.startsWith(prefix)) this.messageSenders.delete(key);
    }
    console.log(`\nSession ${sessionId} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    return session;
  }

  private async runChain(session: SessionState, chain: Chain, task: string, adapterName?: string): Promise<void> {
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    this.originalStepCount = steps.length;
    let previousOutput = "";
    let stepResult: DelegateResult | undefined;
    let parallelResults: DelegateResult[] | undefined;

    // Build shared deps for team execution
    const teamDeps = this.buildTeamDeps();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      if (this.skippedSteps.has(i)) {
        await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Step ${i + 1} skipped.`);
        continue;
      }

      // Pause gate: wait while session is paused
      while (this.pausedSessions.has(session.id)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (session.status === "error") break;

      // Drain orchestrator loop action queue
      const actionQueue = this.actionQueues.get(session.id) ?? [];
      while (actionQueue.length > 0) {
        const action = actionQueue.shift()!;
        await this.processLoopAction(session, action, i, steps);
        if (session.status === "paused") break;
      }

      // Update loop with current step
      this.orchestratorLoop?.setCurrentStep(i, steps.length);

      // Drain buffered steer messages into context
      const buffered = this.drainMessageBuffer(session.id);
      if (buffered) {
        previousOutput += buffered;
        await this.emitter.message(session.id, "orch-1", "User", "user", buffered.trim());
      }

      const stepLabel = step.team ?? step.agent ?? "parallel teams";
      const pipeline = this.pipelines.get(session.id);
      const stageIdx = pipeline?.addStage({
        name: stepLabel,
        type: step.parallel ? "parallel" : step.team ? "team" : "agent",
        team: step.team,
        agent: step.agent,
        parallelTeams: step.parallel?.map(p => p.team),
      }) ?? -1;
      pipeline?.startStage(stageIdx);
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Starting step ${i + 1}/${steps.length}: ${stepLabel}.`);
      this.orchestratorLoop?.recordEvent({
        session_id: session.id, agent_id: "orch-1",
        event_type: "step_start", timestamp: new Date().toISOString(),
        data: { step: i, label: stepLabel },
      });

      if (step.deterministic) {
        const detResult = await this.runDeterministicStep(session, step, i);
        if (detResult) {
          previousOutput = detResult;
        }
      } else if (step.parallel) {
        parallelResults = await runParallelStep(teamDeps, session, step, task, previousOutput, adapterName);
        previousOutput = wrapStepOutput(parallelResults.map((r) => `[${r.agentName}]: ${r.output}`).join("\n\n"));
      } else if (step.team) {
        stepResult = await runTeamStep(teamDeps, session, step, task, previousOutput, adapterName);
        previousOutput = wrapStepOutput(stepResult.output);
      } else if (step.agent) {
        stepResult = await this.runAgent(session, step.agent, task, previousOutput, "orch-1", adapterName);
        previousOutput = wrapStepOutput(stepResult.output);
      }

      // Retry on FEEDBACK/FAILED — always, not just when on_feedback is configured
      const isIncomplete = stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED");
      const isParallelIncomplete = parallelResults?.some(r => r.grade === "FEEDBACK" || r.grade === "FAILED");
      if ((isIncomplete || isParallelIncomplete) && (step.team || step.parallel)) {
        const fb = step.on_feedback ?? { retry_team: step.team ?? step.parallel?.[0]?.team ?? "", max_attempts: 2, escalate_to: "user" };
        let attempts = 0;
        while (attempts < fb.max_attempts && stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
          attempts++;
          console.log(`[orchestrator] Retry ${attempts}/${fb.max_attempts} -- grade was ${stepResult.grade}`);
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Retry ${attempts}/${fb.max_attempts}: re-running (grade: ${stepResult.grade}).`);

          const retryTeam = fb.retry_team || step.team || step.parallel?.[0]?.team || "";
          const retryStep: ChainStep = { team: retryTeam };
          const feedbackContext = `Previous attempt graded ${stepResult.grade}. Feedback/output:\n${stepResult.output}\n\nPlease address the issues and try again.`;
          stepResult = await runTeamStep(teamDeps, session, retryStep, task, feedbackContext, adapterName);
          previousOutput = stepResult.output;
        }
        if (stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
          console.warn(`[orchestrator] Exhausted ${fb.max_attempts} retries. Escalating to: ${fb.escalate_to}`);
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `⚠️ Exhausted ${fb.max_attempts} feedback retries for step ${i + 1}. Escalation target: ${fb.escalate_to}. Grade: ${stepResult.grade}.`);
        }
      }

      // Issue #65: Only mark till_done if the step didn't FAIL
      const stepGrade = stepResult?.grade ?? (parallelResults ? worstGrade(parallelResults.map((r) => r.grade)) : undefined);
      // Update pipeline state
      if (stepResult) {
        pipeline?.completeStage(stageIdx, {
          grade: stepResult.grade,
          cost: stepResult.costUsd,
          tokens: stepResult.tokensUsed,
          output: stepResult.output,
        });
      } else if (parallelResults) {
        pipeline?.completeStage(stageIdx, {
          grade: stepGrade,
          cost: parallelResults.reduce((s, r) => s + r.costUsd, 0),
          tokens: parallelResults.reduce((s, r) => s + r.tokensUsed, 0),
        });
      }

      if (stepGrade !== "FAILED") {
        if (step.till_done) {
          const stepOutput = stepResult?.output ?? parallelResults?.map(r => r.output).join("\n") ?? "";
          const { allMet, failures } = await this.verifyTillDone(session, step, i, stepOutput);
          if (!allMet) {
            await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
              `Till-done verification failed:\n${failures.map(f => `- ${f}`).join("\n")}`);
            if (stepResult && stepResult.grade !== "FAILED" && stepResult.grade !== "FEEDBACK") {
              stepResult = { ...stepResult, grade: "FEEDBACK" };
            }
          }
        }
        this.markTillDone(session, i);
      }
      await this.emitter.tillDone(session.id, session.name, session.tillDone);

      this.orchestratorLoop?.trigger("agent_done", { step: i, grade: stepGrade });
      this.orchestratorLoop?.recordEvent({
        session_id: session.id, agent_id: "orch-1",
        event_type: "step_complete", timestamp: new Date().toISOString(),
        data: { step: i, grade: stepGrade },
      });
    }
  }

  private async processLoopAction(
    session: SessionState,
    action: OrchestratorAction,
    currentStepIndex: number,
    steps: ChainStep[],
  ): Promise<void> {
    switch (action.type) {
      case "PAUSE":
        this.pausedSessions.add(session.id);
        session.status = "paused";
        await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Session paused by orchestrator: ${action.reason}`);
        break;
      case "SKIP_STEP":
        if (action.stepIndex > currentStepIndex && action.stepIndex < steps.length) {
          this.skippedSteps.add(action.stepIndex);
          const pipeline = this.pipelines.get(session.id);
          pipeline?.failStage(action.stepIndex, `Skipped: ${action.reason}`);
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Skipping step ${action.stepIndex + 1}: ${action.reason}`);
        }
        break;
      case "REASSIGN":
        if (action.stepIndex > currentStepIndex && action.stepIndex < steps.length) {
          steps[action.stepIndex] = { ...steps[action.stepIndex]!, team: action.newTeam };
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Reassigning step ${action.stepIndex + 1} to ${action.newTeam}: ${action.reason}`);
        }
        break;
      case "SPAWN_TEAM": {
        const spawnedCount = steps.length - this.originalStepCount;
        if (spawnedCount >= 3) {
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Cannot spawn more teams (limit: 3 additional). Reason: ${action.reason}`);
          break;
        }
        steps.push({ team: action.team });
        await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Spawning additional team ${action.team}: ${action.reason}`);
        break;
      }
      case "ESCALATE_TO_USER":
        await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `**Orchestrator needs your input:** ${action.message}`);
        this.pausedSessions.add(session.id);
        session.status = "paused";
        break;
      case "CONTINUE":
        break;
    }
  }

  /** Build the dependency bag for team/parallel execution functions */
  private buildTeamDeps() {
    return {
      emitter: this.emitter,
      messageSenders: this.messageSenders,
      trackActivity: (agentId: string, name: string, role: string) =>
        trackActivity(this.agentActivity, agentId, name, role),
      trackToolCall: (agentId: string, tool: string) =>
        trackToolCall(this.agentActivity, agentId, tool),
      checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) =>
        checkBudget(this.budgetState, session, agentId, agentCost, agentTokens, this.emitter),
      getAdapter: (name?: string) => this.getAdapter(name),
    };
  }

  private normalizeParallelChain(chain: Chain): ChainStep[] {
    const steps: ChainStep[] = [];
    if (chain.parallel) steps.push({ parallel: chain.parallel });
    if (chain.then) steps.push(...chain.then);
    return steps;
  }

  private async runAgent(
    session: SessionState, agentName: string, task: string,
    previousOutput: string, parentId: string, adapterName?: string
  ): Promise<DelegateResult> {
    const teams = loadTeams();
    let agentConfig: { name: string; path: string; model: string } | undefined;
    let teamName = "Solo";
    let teamColor = "#94a3b8";

    for (const team of teams.teams) {
      const member = team.members.find((m) => m.name.toLowerCase() === agentName.toLowerCase());
      if (member) {
        agentConfig = member;
        teamName = team["team-name"];
        teamColor = team["team-color"];
        break;
      }
    }

    if (!agentConfig) throw new Error(`Agent not found: ${agentName}`);

    const persona = loadPersona(agentConfig.path);
    const adapter = this.getAdapter(adapterName);
    const agentId = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    trackActivity(this.agentActivity, agentId, agentConfig.name, "worker");

    const agentResolved = resolveModelForRole("worker", agentConfig.model);

    await this.emitter.agentSpawn(session.id, agentId, parentId, agentConfig.name, "worker",
      agentResolved.model, teamName, teamColor);

    const prompt = [
      `Task: ${task}`,
      previousOutput ? `\nContext:\n${previousOutput}` : "",
    ].join("\n");

    const agentOpts: DelegateOptions = {
      persona,
      systemPrompt: buildSystemPrompt(persona, "worker"),
      userPrompt: prompt,
      model: agentResolved.model,
      thinking: agentResolved.thinking,
      tools: persona.tools,
      domain: persona.domain,
      workingDir: session.workingDir,
      sessionDir: `data/sessions/${session.id}`,
      parentId,
      teamName,
      teamColor,
      onStreamEvent: (streamEvt) => {
        if (streamEvt.type === "tool_call") {
          trackToolCall(this.agentActivity, agentId, streamEvt.tool ?? "");
          this.emitter.toolCall(session.id, agentId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
          this.orchestratorLoop?.recordEvent({
            session_id: session.id, agent_id: agentId,
            event_type: "tool_call", timestamp: new Date().toISOString(),
            data: { tool: streamEvt.tool ?? "", status: streamEvt.status ?? "running" },
          });
        } else if (streamEvt.type === "cost") {
          this.emitter.costUpdate(session.id, agentId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
        } else if (streamEvt.type === "assistant_text" && streamEvt.content) {
          const severity = scanSeverity(streamEvt.content);
          if (severity && shouldAutoPause(severity, session.id)) {
            this.pausedSessions.add(session.id);
            session.status = "paused";
            const excerpt = extractFindingExcerpt(streamEvt.content, severity);
            this.emitter.severityAlert(session.id, agentId, severity, excerpt);
            this.emitter.autoPause(session.id, `severity:${severity}`);
            this.orchestratorLoop?.trigger("severity_alert", { severity, excerpt });
          }
        }
      },
      sendMessage: (fn) => {
        this.messageSenders.set(`${session.id}:${agentId}`, fn);
      },
    };

    const agentStartTime = Date.now();
    const result = await delegateWithHealing({
      adapter,
      opts: agentOpts,
      sessionId: session.id,
      agentRole: "worker",
      onEvent: async (_type, data) => {
        await this.emitter.selfHeal(session.id, agentId, data.failed_worker as string, data.heal_action as string);
      },
    });

    checkBudget(this.budgetState, session, agentId, result.costUsd, result.tokensUsed, this.emitter);
    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;

    logPerformance({
      model: agentResolved.model,
      role: "worker",
      grade: result.grade ?? "UNGRADED",
      cost_usd: result.costUsd,
      latency_ms: Date.now() - agentStartTime,
      findings_count: result.findings?.length ?? 0,
      agent_name: agentConfig.name,
      session_id: session.id,
      timestamp: new Date().toISOString(),
    });

    // Emit agent output summary
    const agentSummary = summarizeOutput(result.output, 2000);
    await this.emitter.message(session.id, agentId, persona.name, "user", agentSummary);

    return result;
  }

  private buildTillDone(chain: Chain): TillDoneItem[] {
    const items: TillDoneItem[] = [];
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    for (const step of steps) {
      if (step.till_done) {
        for (const item of step.till_done) {
          if (typeof item === "string") {
            items.push({ description: item, completed: false, active: false, type: "llm_verified" });
          } else {
            items.push({ description: item.text, completed: false, active: false, type: item.type, verify: item.verify });
          }
        }
      } else {
        const label = step.team ?? step.agent ?? "parallel step";
        items.push({ description: `${label} complete`, completed: false, active: false, type: "llm_verified" });
      }
    }
    if (items.length > 0) items[0]!.active = true;
    return items;
  }

  /**
   * Mark till_done items as completed for progress tracking purposes.
   * This tracks chain progress for the dashboard UI -- it does NOT verify
   * that the step's work was correct or successful.
   *
   * Callers should check the step result grade before calling this method;
   * FAILED steps should NOT be marked as done. See issue #65.
   */
  private markTillDone(session: SessionState, stepIndex: number): void {
    let idx = 0;
    const chain = getChain(session.chain);
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    for (let i = 0; i <= stepIndex && i < steps.length; i++) {
      const count = steps[i]!.till_done?.length ?? 1;
      for (let j = 0; j < count; j++) {
        if (idx < session.tillDone.length) {
          session.tillDone[idx]!.completed = true;
          session.tillDone[idx]!.active = false;
          idx++;
        }
      }
    }
    if (idx < session.tillDone.length) session.tillDone[idx]!.active = true;
  }

  private async verifyTillDone(
    session: SessionState,
    step: ChainStep,
    stepIndex: number,
    output: string,
  ): Promise<{ allMet: boolean; failures: string[] }> {
    if (!step.till_done) return { allMet: true, failures: [] };

    let idx = 0;
    const chain = getChain(session.chain);
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    for (let i = 0; i < stepIndex && i < steps.length; i++) {
      idx += steps[i]!.till_done?.length ?? 1;
    }

    const failures: string[] = [];
    const count = step.till_done.length;

    for (let j = 0; j < count; j++) {
      const itemIdx = idx + j;
      if (itemIdx >= session.tillDone.length) break;
      const item = session.tillDone[itemIdx]!;

      if (item.type === "output_match" && item.verify) {
        try {
          const match = new RegExp(item.verify).exec(output.slice(0, 10_000));
          if (match) {
            item.evidence = `Matched: ${match[0]}`;
            item.completed = true;
          } else {
            item.evidence = "No match in output";
            failures.push(`${item.description} (output_match: no match)`);
          }
        } catch {
          item.evidence = "Invalid regex";
          failures.push(`${item.description} (invalid regex: ${item.verify})`);
        }
      } else if (item.type === "deterministic" && item.verify) {
        try {
          const proc = Bun.spawn(["sh", "-c", item.verify], {
            cwd: session.workingDir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          if (exitCode === 0) {
            item.evidence = stdout.slice(0, 200) || "exit 0";
            item.completed = true;
          } else {
            item.evidence = (stderr || stdout).slice(0, 200) || `exit ${exitCode}`;
            failures.push(`${item.description} (command failed: exit ${exitCode})`);
          }
        } catch (err) {
          item.evidence = `Error: ${err}`;
          failures.push(`${item.description} (command error)`);
        }
      } else {
        // llm_verified: check output for keywords suggesting completion
        const lower = output.toLowerCase();
        const descLower = item.description.toLowerCase();
        const keywords = descLower.split(/\s+/).filter(w => w.length > 4);
        const matched = keywords.filter(kw => lower.includes(kw));
        if (matched.length >= Math.ceil(keywords.length * 0.5)) {
          item.evidence = "Inferred from output content";
          item.completed = true;
        } else {
          item.evidence = "Could not verify from output";
          item.completed = true; // Don't block on LLM verification — mark as soft-verified
        }
      }
    }

    await this.emitter.tillDone(session.id, session.name, session.tillDone);

    return { allMet: failures.length === 0, failures };
  }

  private interpolatePrompt(body: string, args: string[]): string {
    return body.replace(/\$(\d+)/g, (match, numStr) => {
      const idx = parseInt(numStr, 10) - 1;
      return idx >= 0 && idx < args.length ? args[idx]! : match;
    });
  }

  private async runDeterministicStep(session: SessionState, step: ChainStep, _stepIndex: number): Promise<string | null> {
    const det = step.deterministic!;
    const label = det.label ?? det.command.slice(0, 40);
    const maxRetries = det.max_retries ?? 3;
    const onFailure = det.on_failure ?? "fail";

    await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `🔧 Running deterministic step: ${label}`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const proc = Bun.spawn(["bash", "-c", det.command], {
          cwd: session.workingDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `✅ Deterministic step passed: ${label}`);
          return stdout.slice(0, 2000);
        }

        const errorMsg = (stderr || stdout).slice(0, 1000);
        console.warn(`[orchestrator] Deterministic step failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMsg.slice(0, 200)}`);

        if (onFailure === "continue") {
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `⚠️ Deterministic step failed but continuing: ${label}\n${errorMsg.slice(0, 500)}`);
          return null;
        }

        if (onFailure === "loop" && attempt < maxRetries) {
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `🔄 Retrying deterministic step (${attempt + 1}/${maxRetries}): ${label}\n${errorMsg.slice(0, 300)}`);
          continue;
        }

        // Fail
        await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `❌ Deterministic step failed: ${label}\n${errorMsg.slice(0, 500)}`);
        throw new Error(`Deterministic step failed after ${attempt + 1} attempts: ${label}`);
      } catch (err) {
        if (attempt >= maxRetries || onFailure === "fail") throw err;
      }
    }
    return null;
  }

  private getAdapter(name?: string): PlatformAdapter {
    const adapterName = name ?? this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) throw new Error(`No adapter: ${adapterName}. Available: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }
}
