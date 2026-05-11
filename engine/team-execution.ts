import {
  getTeam,
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModelForRole,
} from "./config";
import { createLogger } from "./logger";
import { delegateWithHealing } from "./self-healing";

const log = createLogger("team-execution");
import { isGitRepo, createWorktree, mergeWorktree, cleanupWorktree } from "./worktree";
import { parseAssignment, summarizeOutput } from "./output-parsing";
import { collectIncrementally } from "./incremental-synthesis";
import { retryWorker, spawnSenior, leadReviewWorkers } from "./worker-lifecycle";
import type { WorkerLifecycleDeps } from "./worker-lifecycle";
import type { EventEmitter } from "./event-emitter";
import { logPerformance } from "./perf-log";
import type {
  PlatformAdapter,
  DelegateOptions,
  DelegateResult,
  SessionState,
  ChainStep,
  TeamConfig,
  PersonaConfig,
  GradeLevel,
  WorkerReview,
} from "./types";
import { buildStreamHandler, buildSendMessage } from "./stream-handler";
import type { OrchestratorLoop } from "./orchestrator-loop";
import type { ConcurrencyLimiter } from "./concurrency";

// ---------------------------------------------------------------------------
// Deps interfaces
// ---------------------------------------------------------------------------

export interface TeamExecutionDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  trackActivity: (agentId: string, name: string, role: string) => void;
  untrackActivity: (agentId: string) => void;
  trackToolCall: (agentId: string, tool: string) => void;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
  getAdapter: (name?: string) => PlatformAdapter;
  orchestratorLoop?: OrchestratorLoop | null;
  pausedSessions?: Set<string>;
  /** Global limiter across all teams in a session */
  sessionLimiter?: ConcurrencyLimiter;
  /** Per-team limiter (created per runTeamStep call) */
  teamLimiterMax?: number;
}

// ---------------------------------------------------------------------------
// Intermediate result interfaces
// ---------------------------------------------------------------------------

export interface PreparedTeamStep {
  teamConfig: TeamConfig;
  leadPersona: PersonaConfig;
  leadId: string;
  leadOpts: DelegateOptions;
  leadResolved: { model: string; thinking: import("./types").ThinkingLevel };
}

export interface LeadDelegationResult {
  leadResult: DelegateResult;
  leadCost: number;
  leadTokens: number;
  earlyReturn?: DelegateResult;
}

export interface WorkerExecutionResult {
  workerResults: DelegateResult[];
  failedWorkers: { name: string; error: string }[];
  workerAssignments: Map<string, string>;
  workerWtIds: string[];
}

export interface WorktreeMergeResult {
  mergedOk: boolean;
  mergeErrors: string[];
}

export interface AccumulatedCosts {
  workerResults: DelegateResult[];
  failedWorkers: { name: string; error: string }[];
  failureNotice: string;
}

export interface ReviewRetryResult {
  reviews: WorkerReview[];
  workerResults: DelegateResult[];
  workerAssignments: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Sub-function deps (each takes only what it needs)
// ---------------------------------------------------------------------------

interface PrepareDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  trackActivity: (agentId: string, name: string, role: string) => void;
  trackToolCall: (agentId: string, tool: string) => void;
  orchestratorLoop?: OrchestratorLoop | null;
}

interface LeadDelegateDeps {
  emitter: EventEmitter;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
  untrackActivity: (agentId: string) => void;
}

interface WorkerExecDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  trackActivity: (agentId: string, name: string, role: string) => void;
  untrackActivity: (agentId: string) => void;
  trackToolCall: (agentId: string, tool: string) => void;
  orchestratorLoop?: OrchestratorLoop | null;
  sessionLimiter?: ConcurrencyLimiter;
  teamLimiterMax?: number;
}

interface WorktreeMergeDeps {
  emitter: EventEmitter;
}

interface AccumulateCostsDeps {
  emitter: EventEmitter;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
}

interface ReviewRetryDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  trackToolCall: (agentId: string, tool: string) => void;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
  orchestratorLoop?: OrchestratorLoop | null;
  pausedSessions?: Set<string>;
}

// ---------------------------------------------------------------------------
// 1. prepareTeamStep
// ---------------------------------------------------------------------------

export async function prepareTeamStep(
  deps: PrepareDeps,
  session: SessionState,
  step: ChainStep,
  task: string,
  previousOutput: string,
  _adapter: PlatformAdapter,
): Promise<PreparedTeamStep> {
  const { emitter, messageSenders, trackActivity, trackToolCall } = deps;
  const teamConfig = getTeam(step.team!);
  const leadPersona = loadPersona(teamConfig.lead.path);
  const leadId = `${step.team}-lead`;

  log.info("Delegating to team", { team: teamConfig["team-name"], session_id: session.id });

  trackActivity(leadId, teamConfig.lead.name, "lead");
  const leadResolved = resolveModelForRole("lead", teamConfig.lead.model);

  await emitter.agentSpawn(session.id, leadId, "orch-1", teamConfig.lead.name, "lead",
    leadResolved.model, teamConfig["team-name"], teamConfig["team-color"]);

  // Lead gets the task + team roster -- produces a briefing for workers
  const members = teamConfig.members.map((m) => `- ${m.name}: ${m["consult-when"] ?? "general tasks"}`).join("\n");
  const prefilledAssignments = teamConfig.members.map((m) => {
    const focus = m["consult-when"] ?? "general tasks";
    return `\n### ASSIGNMENT: ${m.name}\nFocus: ${focus}\nFiles: [list target files/directories]\nExpected output: findings with file path, line number, severity (P0-P3), description, fix`;
  });
  const leadPrompt = [
    `Task: ${task}`,
    previousOutput ? `\nContext from previous step:\n${previousOutput}` : "",
    `\nYour team:\n${members}`,
    `\nYour ONLY job: produce worker assignments. Do NOT do the review yourself.`,
    `Scan the directory structure (ls, find) to identify target files, then fill in the assignments below.`,
    `Keep it fast — 5 tool calls max. The workers will do the deep analysis.`,
    ...prefilledAssignments,
    step.till_done ? `\nTill done:\n${step.till_done.map((t) => `- [ ] ${typeof t === "string" ? t : t.text}`).join("\n")}` : "",
  ].join("\n");

  // Apply per-step overrides from chain config
  const leadSystemPrompt = step.system_prompt_append
    ? buildSystemPrompt(leadPersona, "lead") + "\n\n" + step.system_prompt_append
    : buildSystemPrompt(leadPersona, "lead");
  const leadTools = step.tools_override ?? leadPersona.tools;

  // Emit the prompt being sent to the lead
  await emitter.message(session.id, leadId, "Orchestrator", "user",
    "📋 **Prompt to " + teamConfig.lead.name + ":**\n\n" + leadPrompt.slice(0, 3000));

  const leadOpts: DelegateOptions = {
    persona: leadPersona,
    systemPrompt: leadSystemPrompt,
    userPrompt: leadPrompt,
    model: leadResolved.model,
    thinking: leadResolved.thinking,
    tools: leadTools,
    domain: leadPersona.domain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: "orch-1",
    teamName: teamConfig["team-name"],
    teamColor: teamConfig["team-color"],
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId: leadId,
      trackToolCall, messageSenders, orchestratorLoop: deps.orchestratorLoop,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, leadId),
  };

  return { teamConfig, leadPersona, leadId, leadOpts, leadResolved };
}

// ---------------------------------------------------------------------------
// 2. delegateToLead
// ---------------------------------------------------------------------------

export async function delegateToLead(
  deps: LeadDelegateDeps,
  session: SessionState,
  prepared: PreparedTeamStep,
  adapter: PlatformAdapter,
): Promise<LeadDelegationResult> {
  const { emitter, checkBudget, untrackActivity } = deps;
  const { teamConfig, leadId, leadOpts, leadResolved } = prepared;

  const leadStartTime = Date.now();
  const leadResult = await adapter.delegate(leadOpts);
  await emitter.costUpdate(session.id, leadId, leadResult.costUsd, leadResult.tokensUsed, 0);
  checkBudget(session, leadId, leadResult.costUsd, leadResult.tokensUsed);
  session.totalCost += leadResult.costUsd;
  session.totalTokens += leadResult.tokensUsed;

  logPerformance({
    model: leadResolved.model,
    role: "lead",
    grade: leadResult.grade ?? "UNGRADED",
    cost_usd: leadResult.costUsd,
    latency_ms: Date.now() - leadStartTime,
    findings_count: leadResult.findings?.length ?? 0,
    agent_name: teamConfig.lead.name,
    session_id: session.id,
    timestamp: new Date().toISOString(),
  });

  // Emit lead output summary to conversation stream
  const leadSummary = summarizeOutput(leadResult.output, 2000);
  await emitter.message(session.id, leadId, teamConfig.lead.name, "user", leadSummary);

  // Early return if lead failed or no workers
  if (leadResult.grade === "FAILED" || !teamConfig.members.length) {
    await emitter.agentDone(session.id, leadId, leadResult.grade, leadResult.costUsd);
    untrackActivity(leadId);
    const msg = leadResult.grade === "FAILED"
      ? `${teamConfig["team-name"]} lead could not complete the task.`
      : `${teamConfig["team-name"]} complete (lead only).`;
    await emitter.message(session.id, "orch-1", "Orchestrator", "user", msg);
    return { leadResult, leadCost: leadResult.costUsd, leadTokens: leadResult.tokensUsed, earlyReturn: leadResult };
  }

  return { leadResult, leadCost: leadResult.costUsd, leadTokens: leadResult.tokensUsed };
}

// ---------------------------------------------------------------------------
// 3. executeWorkers
// ---------------------------------------------------------------------------

export async function executeWorkers(
  deps: WorkerExecDeps,
  session: SessionState,
  step: ChainStep,
  task: string,
  teamConfig: TeamConfig,
  leadResult: DelegateResult,
  leadId: string,
  adapter: PlatformAdapter,
): Promise<WorkerExecutionResult> {
  const { emitter, messageSenders, trackActivity, untrackActivity, trackToolCall } = deps;

  const useWorktrees = teamConfig.members.length > 1 && await isGitRepo(session.workingDir);
  const workerWtIds: string[] = [];
  const workerAssignments = new Map<string, string>();

  log.info("Lead briefed, spawning workers", {
    team: teamConfig["team-name"],
    worker_count: teamConfig.members.length,
    workers: teamConfig.members.map((m) => m.name),
    session_id: session.id,
  });
  await emitter.message(session.id, "orch-1", "Orchestrator", "user",
    `${teamConfig["team-name"]} lead assigned ${teamConfig.members.length} workers: ${teamConfig.members.map((m) => m.name).join(", ")}.`);

  // Create per-team concurrency limiter if configured
  const { ConcurrencyLimiter: LimiterClass } = await import("./concurrency");
  const teamLimiter = deps.teamLimiterMax
    ? new LimiterClass(deps.teamLimiterMax)
    : null;

  const workerPromises = teamConfig.members.map(async (member) => {
    const runWorker = async () => {
      const workerPersona = loadPersona(member.path);
      const workerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

      trackActivity(workerId, member.name, "worker");

      let workerDir = session.workingDir;

      if (useWorktrees) {
        const wtId = `${session.id.slice(0, 8)}-${workerId}`;
        workerDir = await createWorktree(session.workingDir, wtId);
        workerWtIds.push(wtId);
      }

      const workerResolved = resolveModelForRole("worker", member.model);

      await emitter.agentSpawn(session.id, workerId, leadId, member.name, "worker",
        workerResolved.model, teamConfig["team-name"], member.color ?? teamConfig["team-color"]);

      // Extract this worker's assignment from the lead brief, or give full brief
      const assignment = parseAssignment(leadResult.output, member.name);
      const workerPrompt = assignment
        ? `Your assignment from ${teamConfig.lead.name}:\n${assignment}\n\nOriginal task: ${task}`
        : `Brief from ${teamConfig.lead.name}:\n${leadResult.output}\n\nOriginal task: ${task}`;
      workerAssignments.set(workerId, assignment ?? leadResult.output);

      // Emit the prompt being sent to the worker
      await emitter.message(session.id, workerId, teamConfig.lead.name, "user",
        "📋 **Assignment to " + member.name + ":**\n\n" + workerPrompt.slice(0, 3000));

      const workerOpts: DelegateOptions = {
        persona: workerPersona,
        systemPrompt: buildSystemPrompt(workerPersona, "worker"),
        userPrompt: workerPrompt,
        model: workerResolved.model,
        thinking: workerResolved.thinking,
        tools: workerPersona.tools,
        domain: workerPersona.domain,
        workingDir: workerDir,
        sessionDir: `data/sessions/${session.id}`,
        parentId: leadId,
        teamName: teamConfig["team-name"],
        teamColor: member.color ?? teamConfig["team-color"],
        onStreamEvent: buildStreamHandler({
          emitter, sessionId: session.id, agentId: workerId,
          trackToolCall, messageSenders, orchestratorLoop: deps.orchestratorLoop,
        }),
        sendMessage: buildSendMessage(messageSenders, session.id, workerId),
      };

      try {
        const workerStartTime = Date.now();
        const result = await delegateWithHealing({
          adapter,
          opts: workerOpts,
          sessionId: session.id,
          agentRole: "worker",
          onEvent: async (_type, data) => {
            await emitter.selfHeal(session.id, workerId, data.failed_worker as string, data.heal_action as string);
          },
        });

        await emitter.costUpdate(session.id, workerId, result.costUsd, result.tokensUsed, 0);

        logPerformance({
          model: workerResolved.model,
          role: "worker",
          grade: result.grade ?? "UNGRADED",
          cost_usd: result.costUsd,
          latency_ms: Date.now() - workerStartTime,
          findings_count: result.findings?.length ?? 0,
          agent_name: member.name,
          session_id: session.id,
          timestamp: new Date().toISOString(),
        });

        const workerSummary = summarizeOutput(result.output, 1500);
        await emitter.message(session.id, workerId, member.name, "user", workerSummary);
        await emitter.agentDone(session.id, workerId, result.grade, result.costUsd);
        untrackActivity(workerId);

        return result;
      } catch (err) {
        log.error("Worker threw", { worker: member.name, worker_id: workerId, error: String(err), session_id: session.id });
        await emitter.agentDone(session.id, workerId, "FAILED", 0);
        untrackActivity(workerId);
        throw err;
      }
    }; // end runWorker

    // Apply concurrency limiters: session-global wraps per-team
    if (deps.sessionLimiter && teamLimiter) {
      return deps.sessionLimiter.run(() => teamLimiter.run(runWorker));
    } else if (deps.sessionLimiter) {
      return deps.sessionLimiter.run(runWorker);
    } else if (teamLimiter) {
      return teamLimiter.run(runWorker);
    }
    return runWorker();
  });

  const settled = await collectIncrementally(workerPromises, {
    onResult: async (result, index, total) => {
      await emitter.message(
        session.id,
        "orch-1",
        "Orchestrator",
        "user",
        `Worker ${index + 1}/${total} complete: ${result.agentName} (${result.grade ?? "UNGRADED"})`,
      );
    },
    onPartialReady: async (completed, remaining) => {
      await emitter.message(
        session.id,
        "orch-1",
        "Orchestrator",
        "user",
        `Partial synthesis available: ${completed.length} workers done, ${remaining} remaining`,
      );
    },
    partialThreshold: 0.5,
  });

  // Partition settled results into fulfilled/rejected
  const workerResults: DelegateResult[] = [];
  const failedWorkers: { name: string; error: string }[] = [];
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      workerResults.push(outcome.value);
    } else {
      const workerName = teamConfig.members[i]?.name ?? `Worker ${i + 1}`;
      const errorMsg = outcome.reason?.message ?? String(outcome.reason) ?? "unknown error";
      failedWorkers.push({ name: workerName, error: errorMsg });
      log.error("Worker failed", { worker: workerName, error: errorMsg, team: teamConfig["team-name"], session_id: session.id });
    }
  }

  return { workerResults, failedWorkers, workerAssignments, workerWtIds };
}

// ---------------------------------------------------------------------------
// 4. mergeWorkerWorktrees
// ---------------------------------------------------------------------------

export async function mergeWorkerWorktrees(
  deps: WorktreeMergeDeps,
  session: SessionState,
  workerWtIds: string[],
): Promise<WorktreeMergeResult> {
  const mergeErrors: string[] = [];

  for (const wtId of workerWtIds) {
    try {
      const { merged, hadChanges } = await mergeWorktree(session.workingDir, wtId);
      if (hadChanges) {
        if (merged) {
          log.info("Merged worktree", { worktree_id: wtId, session_id: session.id });
        } else {
          const errMsg = `Worktree merge failed for ${wtId} — worker changes LOST.`;
          log.critical("Worktree merge failed -- worker changes LOST", { worktree_id: wtId, recovery: ".git/worktrees/", session_id: session.id });
          await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `ERROR: ${errMsg} Check .git/worktrees/ for manual recovery.`);
          mergeErrors.push(errMsg);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    } catch (e) {
      log.error("Worktree cleanup failed", { worktree_id: wtId, error: String(e), session_id: session.id });
      mergeErrors.push(`Cleanup failed for ${wtId}: ${e}`);
    }
  }

  return { mergedOk: mergeErrors.length === 0, mergeErrors };
}

// ---------------------------------------------------------------------------
// 5. accumulateWorkerCosts
// ---------------------------------------------------------------------------

export async function accumulateWorkerCosts(
  deps: AccumulateCostsDeps,
  session: SessionState,
  step: ChainStep,
  teamConfig: TeamConfig,
  execution: WorkerExecutionResult,
): Promise<AccumulatedCosts> {
  const { emitter, checkBudget } = deps;
  const { workerResults, failedWorkers } = execution;

  // Accumulate costs sequentially after all workers complete — no parallel race
  for (const result of workerResults) {
    // Task 3 fix: checkBudget BEFORE accumulating cost to avoid double-counting
    // (projectedCost = session.totalCost + agentCost — if we already added agentCost, it double-counts)
    checkBudget(session, result.agentId, result.costUsd, result.tokensUsed);
    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;
  }

  // Emit worker_failed events for failed workers
  for (const failed of failedWorkers) {
    await emitter.emit({
      session_id: session.id,
      agent_id: `${step.team}-${failed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      event_type: "worker_failed",
      timestamp: new Date().toISOString(),
      data: { worker_name: failed.name, error: failed.error, team: teamConfig["team-name"] },
    });
  }

  // Build failure notice for lead review context
  let failureNotice = "";
  if (failedWorkers.length > 0) {
    failureNotice = `\n\nWARNING: ${failedWorkers.length} worker(s) failed during execution:\n` +
      failedWorkers.map(f => `- ${f.name}: ${f.error}`).join("\n") +
      `\nYou are reviewing ${workerResults.length} of ${teamConfig.members.length} expected results.`;

    await emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `⚠️ ${failedWorkers.length} worker(s) failed: ${failedWorkers.map(f => f.name).join(", ")}. Lead will review ${workerResults.length} of ${teamConfig.members.length} expected results.`);
  }

  return { workerResults, failedWorkers, failureNotice };
}

// ---------------------------------------------------------------------------
// 6. leadReviewAndRetry
// ---------------------------------------------------------------------------

export async function leadReviewAndRetry(
  deps: ReviewRetryDeps,
  session: SessionState,
  step: ChainStep,
  task: string,
  teamConfig: TeamConfig,
  leadPersona: PersonaConfig,
  leadId: string,
  adapter: PlatformAdapter,
  workerResults: DelegateResult[],
  workerAssignments: Map<string, string>,
  failureNotice: string,
): Promise<ReviewRetryResult> {
  const lifecycleDeps: WorkerLifecycleDeps = {
    emitter: deps.emitter,
    messageSenders: deps.messageSenders,
    trackToolCall: deps.trackToolCall,
    checkBudget: deps.checkBudget,
    orchestratorLoop: deps.orchestratorLoop,
    pausedSessions: deps.pausedSessions,
  };

  // Lead reviews worker output (include failure notice so lead knows about missing workers)
  let reviews = await leadReviewWorkers(
    lifecycleDeps, session, teamConfig, leadPersona, workerResults,
    workerAssignments, task + failureNotice, adapter, step, leadId
  );

  // Retry loop: NEEDS_WORK workers get reworked prompts and retry
  const maxRetries = step.max_worker_retries ?? 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const needsWork = reviews.filter(r => r.grade === "NEEDS_WORK");
    if (needsWork.length === 0) break;

    log.info("Retry cycle", { attempt, max_retries: maxRetries, workers_needing_rework: needsWork.length, session_id: session.id });
    await deps.emitter.message(session.id, leadId, "Orchestrator", "user",
      `Retry cycle ${attempt}/${maxRetries}: ${needsWork.map(r => r.workerName).join(", ")} need rework.`);

    for (const review of needsWork) {
      if (review.directFix) {
        log.info("Lead applying direct fix", { worker: review.workerName, session_id: session.id });
        await deps.emitter.message(session.id, leadId, teamConfig.lead.name, "user",
          `Applying direct fix for ${review.workerName}:\n${review.directFix.slice(0, 500)}`);
        review.grade = "PASS";
        const idx = workerResults.findIndex(r => r.agentId === review.workerId);
        if (idx !== -1) {
          workerResults[idx]!.output += `\n\n--- Lead Direct Fix ---\n${review.directFix}`;
        }
        continue;
      }

      if (review.spawnSr && review.srDomains?.length) {
        const srResult = await spawnSenior(
          lifecycleDeps, session, teamConfig, review, task, adapter, leadId, step
        );
        const idx = workerResults.findIndex(r => r.agentId === review.workerId);
        if (idx !== -1) workerResults[idx] = srResult;
        review.grade = "PASS";
        continue;
      }

      if (review.reworkedPrompt) {
        const member = teamConfig.members.find(
          m => m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === review.workerId.replace(`${step.team}-`, "")
        );
        if (!member) continue;

        const retryResult = await retryWorker(
          lifecycleDeps, session, teamConfig, member, review.reworkedPrompt, task,
          adapter, leadId, attempt, step
        );

        const idx = workerResults.findIndex(r => r.agentId === review.workerId);
        if (idx !== -1) workerResults[idx] = retryResult;
        workerAssignments.set(review.workerId, review.reworkedPrompt);
      }
    }

    // Re-review only retried workers (not direct-fixed or SR-spawned)
    const retriedResults = workerResults.filter(r =>
      needsWork.some(nw => nw.workerId === r.agentId && nw.grade === "NEEDS_WORK")
    );
    if (retriedResults.length > 0) {
      const retriedReviews = await leadReviewWorkers(
        lifecycleDeps, session, teamConfig, leadPersona, retriedResults,
        workerAssignments, task, adapter, step, leadId
      );
      for (const retried of retriedReviews) {
        const origIdx = reviews.findIndex(r => r.workerId === retried.workerId);
        if (origIdx !== -1) {
          reviews[origIdx] = retried;
        } else {
          reviews.push(retried);
        }
      }
    }
  }

  return { reviews, workerResults, workerAssignments };
}

// ---------------------------------------------------------------------------
// 7. buildTeamResult
// ---------------------------------------------------------------------------

export function buildTeamResult(
  leadResult: DelegateResult,
  leadId: string,
  leadName: string,
  workerResults: DelegateResult[],
  reviews: WorkerReview[],
): DelegateResult {
  const allPass = reviews.every(r => r.grade === "PASS");
  const reviewGrade: GradeLevel = allPass ? "VERIFIED" : "FAILED";
  const combinedOutput = workerResults.map((r) => `[${r.agentName}]:\n${r.output}`).join("\n\n---\n\n");
  const totalCost = leadResult.costUsd + workerResults.reduce((s, r) => s + r.costUsd, 0);

  return {
    agentId: leadId,
    agentName: leadName,
    output: combinedOutput,
    grade: reviewGrade,
    findings: [
      ...workerResults.flatMap((r) => r.findings ?? []),
      ...reviews.filter(r => r.feedback).map(r => `[${r.workerName}] ${r.feedback}`),
    ],
    qualityNotes: reviews.flatMap(r => r.qualityNotes ?? []),
    reviews,
    costUsd: totalCost,
    tokensUsed: leadResult.tokensUsed + workerResults.reduce((s, r) => s + r.tokensUsed, 0),
  };
}

// ---------------------------------------------------------------------------
// Coordinator: runTeamStep
// ---------------------------------------------------------------------------

/**
 * Run a single team step: delegate to lead, spawn workers, review, retry loop.
 */
export async function runTeamStep(
  deps: TeamExecutionDeps,
  session: SessionState,
  step: ChainStep,
  task: string,
  previousOutput: string,
  adapterName?: string,
): Promise<DelegateResult> {
  const adapter = deps.getAdapter(adapterName);

  // 1. Prepare lead prompt, config, delegate options
  const prepared = await prepareTeamStep(deps, session, step, task, previousOutput, adapter);

  // 2. Delegate to lead, get result (may early-return if lead fails or no workers)
  const leadDelegation = await delegateToLead(deps, session, prepared, adapter);
  if (leadDelegation.earlyReturn) return leadDelegation.earlyReturn;

  // 3. Spawn workers in parallel, collect results
  const execution = await executeWorkers(
    deps, session, step, task,
    prepared.teamConfig, leadDelegation.leadResult, prepared.leadId, adapter,
  );

  // 4. Merge worker worktrees (always runs, even if workers threw)
  await mergeWorkerWorktrees(deps, session, execution.workerWtIds);

  // 5. Accumulate costs, build failure notice
  const accumulated = await accumulateWorkerCosts(
    deps, session, step, prepared.teamConfig, execution,
  );

  // 6. Lead review + retry loop
  const reviewed = await leadReviewAndRetry(
    deps, session, step, task,
    prepared.teamConfig, prepared.leadPersona, prepared.leadId, adapter,
    accumulated.workerResults, execution.workerAssignments, accumulated.failureNotice,
  );

  // 7. Build final result
  const result = buildTeamResult(
    leadDelegation.leadResult, prepared.leadId, prepared.teamConfig.lead.name,
    reviewed.workerResults, reviewed.reviews,
  );

  await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
    `${prepared.teamConfig["team-name"]} complete. Lead reviewed ${reviewed.reviews.length} workers: ${reviewed.reviews.map(r => `${r.workerName}=${r.grade}`).join(", ")}. Grade: ${result.grade}. Cost: $${result.costUsd.toFixed(3)}.`);

  return result;
}

// ---------------------------------------------------------------------------
// runParallelStep (unchanged)
// ---------------------------------------------------------------------------

/**
 * Run multiple teams in parallel, each in their own worktree if applicable.
 */
export async function runParallelStep(
  deps: TeamExecutionDeps,
  session: SessionState,
  step: ChainStep,
  task: string,
  previousOutput: string,
  adapterName?: string,
): Promise<DelegateResult[]> {
  const teams = step.parallel!;
  log.info("Running parallel teams", { team_count: teams.length, teams: teams.map((t) => t.team), session_id: session.id });

  const useWorktrees = teams.length > 1 && await isGitRepo(session.workingDir);
  const teamWtIds: string[] = [];

  const teamSessions: SessionState[] = [];
  const promises = teams.map(async (t, idx) => {
    const teamSession: SessionState = useWorktrees ? {
      ...session,
      totalCost: 0,
      totalTokens: 0,
      agents: new Map(),
      tillDone: session.tillDone.map(item => ({ ...item })),
      events: [...session.events],
    } : session;
    teamSessions.push(teamSession);
    if (useWorktrees) {
      const wtId = `${session.id.slice(0, 8)}-team-${idx}`;
      teamSession.workingDir = await createWorktree(session.workingDir, wtId);
      teamWtIds.push(wtId);
      log.debug("Created team worktree", { team: t.team, worktree_dir: teamSession.workingDir, session_id: session.id });
    }
    return runTeamStep(deps, teamSession, { ...step, team: t.team }, task, previousOutput, adapterName);
  });

  const settled = await Promise.allSettled(promises);

  // Worktree cleanup always runs, even if a team threw
  for (const wtId of teamWtIds) {
    try {
      const { merged, hadChanges } = await mergeWorktree(session.workingDir, wtId);
      if (hadChanges) {
        if (merged) {
          log.info("Merged team worktree", { worktree_id: wtId, session_id: session.id });
        } else {
          log.critical("Team worktree merge failed -- worker changes LOST", { worktree_id: wtId, recovery: ".git/worktrees/", session_id: session.id });
          await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `ERROR: Team worktree merge failed for ${wtId} — worker changes were lost. Check .git/worktrees/ for manual recovery.`);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    } catch (e) {
      log.error("Team worktree cleanup failed", { worktree_id: wtId, error: String(e), session_id: session.id });
    }
  }

  // Accumulate team costs sequentially to avoid races
  if (useWorktrees) {
    for (const ts of teamSessions) {
      session.totalCost += ts.totalCost;
      session.totalTokens += ts.totalTokens;
    }
  }

  const results: DelegateResult[] = [];
  const failedTeams: { name: string; error: string }[] = [];
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const teamName = teams[i]?.team ?? `Team ${i + 1}`;
      const errorMsg = outcome.reason?.message ?? String(outcome.reason) ?? "unknown error";
      failedTeams.push({ name: teamName, error: errorMsg });
      log.error("Parallel team failed", { team: teamName, error: errorMsg, session_id: session.id });

      // Emit worker_failed event to dashboard for each failed team
      await deps.emitter.emit({
        session_id: session.id,
        agent_id: `${teamName}-lead`,
        event_type: "worker_failed",
        timestamp: new Date().toISOString(),
        data: { worker_name: teamName, error: errorMsg, team: teamName },
      });
    }
  }

  if (failedTeams.length > 0) {
    await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `⚠️ ${failedTeams.length} parallel team(s) failed: ${failedTeams.map(f => f.name).join(", ")}. Synthesizing ${results.length} of ${teams.length} expected results.`);
  }

  // Synthesize parallel results into unified report
  const { emitter, getAdapter, trackToolCall: trackTool, checkBudget: budgetCheck, messageSenders } = deps;
  const allTeams = loadTeams();
  const synthPersona = loadPersona(allTeams.orchestrator.path);
  const synthResolved = resolveModelForRole("orchestrator");
  const synthId = `synth-${session.id.slice(0, 8)}`;
  const adapter = getAdapter(adapterName);

  log.info("Synthesizing parallel team outputs", { result_count: results.length, session_id: session.id });

  await emitter.agentSpawn(session.id, synthId, "orch-1", "Synthesis", "orchestrator",
    synthResolved.model, "Synthesis", "#a855f7");

  const teamOutputs = results.map((r, i) =>
    `### Team: ${teams[i]?.team ?? `Team ${i + 1}`}\nGrade: ${r.grade ?? "UNGRADED"}\n\n${r.output}`
  ).join("\n\n---\n\n");

  const failedTeamNotice = failedTeams.length > 0
    ? `\n\nWARNING: ${failedTeams.length} team(s) failed during execution:\n` +
      failedTeams.map(f => `- ${f.name}: ${f.error}`).join("\n") +
      `\nYou are synthesizing ${results.length} of ${teams.length} expected team results.`
    : "";

  const synthesisPrompt = [
    "Multiple teams completed this task in parallel. Synthesize their findings:",
    "",
    teamOutputs,
    "",
    "Produce a unified report:",
    "1. **Agreements** — findings all teams agree on",
    "2. **Conflicts** — where teams disagree, resolve each with reasoning",
    "3. **Unique findings** — found by only one team, validate or dismiss",
    "4. **Final prioritized list** (P0-P3)",
    "5. **GRADE:** PASS | FEEDBACK | FAILED",
    failedTeamNotice,
  ].join("\n");

  await emitter.message(session.id, synthId, "Orchestrator", "user",
    `📋 **Synthesis prompt:**\n\n${synthesisPrompt.slice(0, 3000)}`);

  const synthOpts: DelegateOptions = {
    persona: synthPersona,
    systemPrompt: "You are synthesizing parallel team outputs into a unified report. Be objective. Resolve conflicts with evidence. Deduplicate findings.",
    userPrompt: synthesisPrompt,
    model: synthResolved.model,
    thinking: synthResolved.thinking,
    tools: ["read", "grep", "glob"],
    domain: synthPersona.domain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: "orch-1",
    teamName: "Synthesis",
    teamColor: "#a855f7",
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId: synthId,
      trackToolCall: trackTool, messageSenders, orchestratorLoop: deps.orchestratorLoop,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, synthId),
  };

  const synthResult = await adapter.delegate(synthOpts);
  await emitter.costUpdate(session.id, synthId, synthResult.costUsd, synthResult.tokensUsed, 0);
  budgetCheck(session, synthId, synthResult.costUsd, synthResult.tokensUsed);
  session.totalCost += synthResult.costUsd;
  session.totalTokens += synthResult.tokensUsed;

  const synthSummary = summarizeOutput(synthResult.output, 2000);
  await emitter.message(session.id, synthId, "Synthesis", "user", synthSummary);
  await emitter.agentDone(session.id, synthId, synthResult.grade ?? "VERIFIED", synthResult.costUsd);

  return [{
    ...synthResult,
    agentName: "Synthesis",
    agentId: synthId,
  }];
}
