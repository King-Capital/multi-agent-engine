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
import { sanitizeAgentInput, validateAgentOutput } from "./security";
import { isGitRepo, createWorktree, mergeWorktree, cleanupWorktree } from "./worktree";
import { delegateWithHealing } from "./self-healing";
import { PipelineTracker } from "./pipeline-state";
import { SandboxPool } from "./sandbox-pool";

// Extracted modules
import { parseAssignment, parseReviews, summarizeOutput, worstGrade } from "./output-parsing";
import { trackActivity, trackToolCall, startMonitor, stopMonitor } from "./monitoring";
import type { AgentActivity } from "./monitoring";
import { loadBudgets, checkBudget } from "./budget";
import type { BudgetState } from "./budget";
import { sendUserMessage, listenForUserMessages, stopListening } from "./messaging";
import { retryWorker, spawnSenior, leadReviewWorkers } from "./worker-lifecycle";
import { runTeamStep, runParallelStep } from "./team-execution";

import type {
  PlatformAdapter,
  DelegateResult,
  DelegateOptions,
  Chain,
  ChainStep,
  SessionState,
  TillDoneItem,
  GradeLevel,
} from "./types";

export class Orchestrator {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private defaultAdapter: string = "";
  private emitter: EventEmitter;
  private dashboardUrl: string;
  private sessions: Map<string, SessionState> = new Map();
  private agentActivity: Map<string, AgentActivity> = new Map();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private messageSenders: Map<string, (msg: string) => void> = new Map();
  private pipelines: Map<string, PipelineTracker> = new Map();
  private sandboxPool: SandboxPool | null = null;
  private sseAbort: AbortController | null = null;
  private budgetState: BudgetState = { budgets: null, budgetWarned: false };

  constructor(dashboardUrl?: string, apiToken?: string) {
    this.dashboardUrl = dashboardUrl ?? "http://localhost:8400";
    this.emitter = new EventEmitter(dashboardUrl, apiToken);
  }

  enableSandboxPool(opts?: { pveApi?: string; pveToken?: string; poolSize?: number }): void {
    this.sandboxPool = new SandboxPool(opts);
    console.log(`[orchestrator] Sandbox pool enabled (${this.sandboxPool.status().total} sandboxes)`);
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
    sendUserMessage(this.messageSenders, sessionId, message);
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
    this.monitorInterval = startMonitor(this.agentActivity, sessionId);
    this.sseAbort = listenForUserMessages(this.dashboardUrl, sessionId, (sid, content) => {
      this.sendUserMessage(sid, content);
    });

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

    stopMonitor(this.monitorInterval, this.agentActivity);
    this.monitorInterval = null;
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
    let previousOutput = "";
    let stepResult: DelegateResult | undefined;
    let parallelResults: DelegateResult[] | undefined;

    // Build shared deps for team execution
    const teamDeps = this.buildTeamDeps();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

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

      if (step.deterministic) {
        const detResult = await this.runDeterministicStep(session, step, i);
        if (detResult) {
          previousOutput = detResult;
        }
      } else if (step.parallel) {
        parallelResults = await runParallelStep(teamDeps, session, step, task, previousOutput, adapterName);
        previousOutput = parallelResults.map((r) => `[${r.agentName}]: ${r.output}`).join("\n\n");
      } else if (step.team) {
        stepResult = await runTeamStep(teamDeps, session, step, task, previousOutput, adapterName);
        previousOutput = stepResult.output;
      } else if (step.agent) {
        stepResult = await this.runAgent(session, step.agent, task, previousOutput, "orch-1", adapterName);
        previousOutput = stepResult.output;
      }

      // Issue #64: on_feedback retry loop for team steps
      if (step.on_feedback && stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
        const fb = step.on_feedback;
        let attempts = 0;
        while (attempts < fb.max_attempts && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
          attempts++;
          console.log(`[orchestrator] on_feedback retry ${attempts}/${fb.max_attempts} -- re-running team "${fb.retry_team}" (grade was ${stepResult.grade})`);
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Feedback retry ${attempts}/${fb.max_attempts}: re-running ${fb.retry_team} (grade: ${stepResult.grade}).`);

          const retryStep: ChainStep = { team: fb.retry_team };
          const feedbackContext = `Previous attempt graded ${stepResult.grade}. Feedback/output:\n${stepResult.output}\n\nPlease address the issues and try again.`;
          stepResult = await runTeamStep(teamDeps, session, retryStep, task, feedbackContext, adapterName);
          previousOutput = stepResult.output;
        }
        if (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED") {
          console.warn(`[orchestrator] on_feedback exhausted ${fb.max_attempts} retries. Escalating to: ${fb.escalate_to}`);
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
        this.markTillDone(session, i);
      }
      await this.emitter.tillDone(session.id, session.name, session.tillDone);
    }
  }

  /** Build the dependency bag for team/parallel execution functions */
  private buildTeamDeps() {
    return {
      emitter: this.emitter,
      messageSenders: this.messageSenders,
      sandboxPool: this.sandboxPool,
      trackActivity: (agentId: string, name: string, role: string) =>
        trackActivity(this.agentActivity, agentId, name, role),
      trackToolCall: (agentId: string, tool: string) =>
        trackToolCall(this.agentActivity, agentId, tool),
      checkBudget: (session: SessionState, agentId: string, agentCost: number) =>
        checkBudget(this.budgetState, session, agentId, agentCost, this.emitter),
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
      systemPrompt: buildSystemPrompt(persona),
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
        } else if (streamEvt.type === "cost") {
          this.emitter.costUpdate(session.id, agentId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
        }
      },
      sendMessage: (fn) => {
        this.messageSenders.set(`${session.id}:${agentId}`, fn);
      },
    };

    const result = await delegateWithHealing({
      adapter,
      opts: agentOpts,
      sessionId: session.id,
      agentRole: "worker",
      onEvent: async (_type, data) => {
        await this.emitter.selfHeal(session.id, agentId, data.failed_worker as string, data.heal_action as string);
      },
    });

    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;
    checkBudget(this.budgetState, session, agentId, result.costUsd, this.emitter);

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
        for (const desc of step.till_done) {
          items.push({ description: desc, completed: false, active: false });
        }
      } else {
        const label = step.team ?? step.agent ?? "parallel step";
        items.push({ description: `${label} complete`, completed: false, active: false });
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

  private interpolatePrompt(body: string, args: string[]): string {
    return body.replace(/\$(\d+)/g, (match, numStr) => {
      const idx = parseInt(numStr, 10) - 1;
      return idx >= 0 && idx < args.length ? args[idx]! : match;
    });
  }

  private async runDeterministicStep(session: SessionState, step: ChainStep, stepIndex: number): Promise<string | null> {
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
