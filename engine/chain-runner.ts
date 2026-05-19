import {
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModelForRole,
} from "./config";
import { sanitizeAgentInput } from "./security";
import { createLogger } from "./logger";
import { delegateWithHealing } from "./self-healing";
import { summarizeOutput, worstGrade } from "./output-parsing";
import { trackActivity, trackToolCall } from "./monitoring";
import { checkBudget } from "./budget";
import type { BudgetState } from "./budget";
import { runTeamStep, runParallelStep } from "./team-execution";
import { isReviewOnlyStep, readOnlyTools } from "./review-mode";
import { buildParticipantCapabilities } from "./participant-capabilities";
import type { TeamExecutionDeps } from "./team-execution";
import { logPerformance } from "./perf-log";
import { buildStreamHandler, buildSendMessage } from "./stream-handler";
import type { AgentActivity } from "./monitoring";
import type { OrchestratorLoop } from "./orchestrator-loop";
import type { PipelineTracker } from "./pipeline-state";
import type { EventEmitter } from "./event-emitter";

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
import { transitionStatus } from "./session-state";

const log = createLogger("chain-runner");

function wrapStepOutput(output: string): string {
  return `<previous_agent_output>\n${sanitizeAgentInput(output)}\n</previous_agent_output>`;
}

/** Dependencies injected by the Orchestrator into chain-runner functions. */
export interface ChainRunnerDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  agentActivity: Map<string, AgentActivity>;
  budgetState: BudgetState;
  pausedSessions: Set<string>;
  messageBuffers: Map<string, string[]>;
  actionQueues: Map<string, OrchestratorAction[]>;
  skippedSteps: Set<number>;
  originalStepCount: number;
  pipelines: Map<string, PipelineTracker>;
  orchestratorLoop: OrchestratorLoop | null;
  getAdapter: (name?: string) => PlatformAdapter;
  buildTeamDeps: () => TeamExecutionDeps;
  drainMessageBuffer: (sessionId: string) => string;
}

/** Convert a chain with top-level parallel/then into flat steps. */
export function normalizeParallelChain(chain: Chain): ChainStep[] {
  const steps: ChainStep[] = [];
  if (chain.parallel) steps.push({ parallel: chain.parallel });
  if (chain.then) steps.push(...chain.then);
  return steps;
}

/** Replace $1, $2 placeholders in a prompt with positional args. */
export function interpolatePrompt(body: string, args: string[]): string {
  return body.replace(/\$(\d+)/g, (match, numStr) => {
    const idx = parseInt(numStr, 10) - 1;
    return idx >= 0 && idx < args.length ? args[idx]! : match;
  });
}

/** Build initial till_done tracking array from chain step definitions. */
export function buildTillDone(chain: Chain): TillDoneItem[] {
  const items: TillDoneItem[] = [];
  const steps = chain.steps ?? normalizeParallelChain(chain);
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
 * Uses the runtime `steps` array (not a YAML reload) so that REASSIGN/SPAWN_TEAM
 * mutations are reflected correctly.
 */
export function markTillDone(session: SessionState, stepIndex: number, steps: ChainStep[]): void {
  let idx = 0;
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

export async function verifyTillDone(
  emitter: EventEmitter,
  session: SessionState,
  step: ChainStep,
  stepIndex: number,
  output: string,
  steps: ChainStep[],
): Promise<{ allMet: boolean; failures: string[] }> {
  if (!step.till_done) return { allMet: true, failures: [] };

  let idx = 0;
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
        const match = new RegExp(item.verify).exec(output.slice(0, 50_000));
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
        const proc = Bun.spawn(["bash", "-c", item.verify], {
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
        failures.push(`${item.description} (llm_verified: insufficient evidence)`);
      }
    }
  }

  await emitter.tillDone(session.id, session.name, session.tillDone);

  return { allMet: failures.length === 0, failures };
}

export async function runDeterministicStep(
  emitter: EventEmitter,
  session: SessionState,
  step: ChainStep,
  _stepIndex: number,
): Promise<string | null> {
  const det = step.deterministic!;
  const label = det.label ?? det.command.slice(0, 40);
  const maxRetries = det.max_retries ?? 3;
  const onFailure = det.on_failure ?? "fail";

  await emitter.message(session.id, "orch-1", "Orchestrator", "user",
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
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `✅ Deterministic step passed: ${label}`);
        return stdout.slice(0, 2000);
      }

      const errorMsg = (stderr || stdout).slice(0, 1000);
      log.warn("Deterministic step failed", { label, attempt: attempt + 1, max_attempts: maxRetries + 1, error: errorMsg.slice(0, 200), session_id: session.id });

      if (onFailure === "continue") {
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `⚠️ Deterministic step failed but continuing: ${label}\n${errorMsg.slice(0, 500)}`);
        return null;
      }

      if (onFailure === "loop" && attempt < maxRetries) {
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `🔄 Retrying deterministic step (${attempt + 1}/${maxRetries}): ${label}\n${errorMsg.slice(0, 300)}`);
        continue;
      }

      // Fail
      await emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `❌ Deterministic step failed: ${label}\n${errorMsg.slice(0, 500)}`);
      throw new Error(`Deterministic step failed after ${attempt + 1} attempts: ${label}`);
    } catch (err) {
      if (attempt >= maxRetries || onFailure === "fail") throw err;
    }
  }
  return null;
}

export async function runAgent(
  deps: ChainRunnerDeps,
  session: SessionState,
  agentName: string,
  task: string,
  previousOutput: string,
  parentId: string,
  adapterName?: string,
  step?: ChainStep,
): Promise<DelegateResult> {
  const { emitter, messageSenders, agentActivity, budgetState, pausedSessions, orchestratorLoop } = deps;
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
  const adapter = deps.getAdapter(adapterName);
  const agentId = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  trackActivity(agentActivity, agentId, agentConfig.name, "worker");

  const agentResolved = resolveModelForRole("worker", agentConfig.model);
  const reviewOnly = step ? isReviewOnlyStep(step) : false;
  const agentTools = reviewOnly ? readOnlyTools(persona.tools) : persona.tools;
  const agentDomain = reviewOnly ? { ...persona.domain, write: [], update: [] } : persona.domain;

  await emitter.agentSpawn(session.id, agentId, parentId, agentConfig.name, "worker",
    agentResolved.model, teamName, teamColor, undefined,
    buildParticipantCapabilities({
      tools: agentTools, domain: agentDomain, model: agentResolved.model,
    }));

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
    tools: agentTools,
    domain: agentDomain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId,
    teamName,
    teamColor,
    abortSignal: session.abortSignal,
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId,
      trackToolCall: (id, tool) => trackToolCall(agentActivity, id, tool),
      messageSenders, orchestratorLoop, pausedSessions, session,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, agentId),
  };

  const agentStartTime = Date.now();
  const result = await delegateWithHealing({
    adapter,
    opts: agentOpts,
    sessionId: session.id,
    agentRole: "worker",
    onEvent: async (_type, data) => {
      await emitter.selfHeal(session.id, agentId, data.failed_worker as string, data.heal_action as string);
    },
  });

  checkBudget(budgetState, session, agentId, result.costUsd, result.tokensUsed, emitter);
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
  await emitter.message(session.id, agentId, persona.name, "user", agentSummary);
  await emitter.agentDone(session.id, agentId, result.grade, result.costUsd, {
    outputArtifact: result.outputArtifact,
    taskReport: result.taskReport,
  });

  return result;
}

export async function processLoopAction(
  deps: ChainRunnerDeps,
  session: SessionState,
  action: OrchestratorAction,
  currentStepIndex: number,
  steps: ChainStep[],
): Promise<void> {
  const { emitter, pausedSessions, pipelines, originalStepCount } = deps;

  switch (action.type) {
    case "PAUSE":
      pausedSessions.add(session.id);
      transitionStatus(session, "paused", "chain-runner:PAUSE");
      await emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Session paused by orchestrator: ${action.reason}`);
      break;
    case "SKIP_STEP":
      if (action.stepIndex > currentStepIndex && action.stepIndex < steps.length) {
        deps.skippedSteps.add(action.stepIndex);
        const pipeline = pipelines.get(session.id);
        pipeline?.failStage(action.stepIndex, `Skipped: ${action.reason}`);
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Skipping step ${action.stepIndex + 1}: ${action.reason}`);
      }
      break;
    case "REASSIGN":
      if (action.stepIndex > currentStepIndex && action.stepIndex < steps.length) {
        steps[action.stepIndex] = { ...steps[action.stepIndex]!, team: action.newTeam };
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Reassigning step ${action.stepIndex + 1} to ${action.newTeam}: ${action.reason}`);
      }
      break;
    case "SPAWN_TEAM": {
      const spawnedCount = steps.length - originalStepCount;
      if (spawnedCount >= 3) {
        await emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Cannot spawn more teams (limit: 3 additional). Reason: ${action.reason}`);
        break;
      }
      steps.push({ team: action.team });
      await emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Spawning additional team ${action.team}: ${action.reason}`);
      break;
    }
    case "ESCALATE_TO_USER":
      await emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `**Orchestrator needs your input:** ${action.message}`);
      pausedSessions.add(session.id);
      transitionStatus(session, "paused", "chain-runner:ESCALATE_TO_USER");
      break;
    case "CONTINUE":
      break;
  }
}

/** Execute a chain's steps sequentially, delegating to teams/agents. */
export async function runChain(
  deps: ChainRunnerDeps,
  session: SessionState,
  chain: Chain,
  task: string,
  adapterName?: string,
): Promise<void> {
  const steps = chain.steps ?? normalizeParallelChain(chain);
  deps.originalStepCount = steps.length;
  let previousOutput = "";
  let stepResult: DelegateResult | undefined;
  let parallelResults: DelegateResult[] | undefined;

  const teamDeps = deps.buildTeamDeps();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const stepLabel = step.team ?? step.agent ?? step.deterministic?.label ?? step.deterministic?.command ?? "parallel teams";
    const stepNumber = i + 1;

    stepResult = undefined;
    parallelResults = undefined;

    if (deps.skippedSteps.has(i)) {
      await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Step ${stepNumber} skipped.`);
      log.info(`Step ${stepNumber} starting: ${stepLabel}`, { trace_type: "chain.step.start", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team });
      log.info(`Step ${stepNumber} skipped`, { trace_type: "chain.step.end", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team, status: "skipped" });
      continue;
    }

    while (deps.pausedSessions.has(session.id)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (session.status === "error") break;

    const actionQueue = deps.actionQueues.get(session.id) ?? [];
    while (actionQueue.length > 0) {
      const action = actionQueue.shift()!;
      await processLoopAction(deps, session, action, i, steps);
      if (session.status === "paused") break;
    }

    deps.orchestratorLoop?.setCurrentStep(i, steps.length);

    const buffered = deps.drainMessageBuffer(session.id);
    if (buffered) {
      previousOutput += buffered;
      await deps.emitter.message(session.id, "orch-1", "User", "user", buffered.trim());
    }

    const pipeline = deps.pipelines.get(session.id);
    const stageIdx = pipeline?.addStage({
      name: stepLabel,
      type: step.parallel ? "parallel" : step.team ? "team" : "agent",
      team: step.team,
      agent: step.agent,
      parallelTeams: step.parallel?.map(p => p.team),
    }) ?? -1;
    pipeline?.startStage(stageIdx);
    await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `Starting step ${stepNumber}/${steps.length}: ${stepLabel}.`);
    const stepStartedAt = Date.now();
    log.info(`Step ${stepNumber} starting: ${stepLabel}`, { trace_type: "chain.step.start", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team });
    try {
      deps.orchestratorLoop?.recordEvent({
        session_id: session.id, agent_id: "orch-1",
        event_type: "step_start", timestamp: new Date().toISOString(),
        data: { step: i, label: stepLabel },
      });
    } catch (err) {
      log.warn("Failed to record orchestrator step start", { session_id: session.id, error_type: err instanceof Error ? err.name : typeof err });
    }

    try {
      if (step.deterministic) {
        const detResult = await runDeterministicStep(deps.emitter, session, step, i);
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
        stepResult = await runAgent(deps, session, step.agent, task, previousOutput, "orch-1", adapterName, step);
        previousOutput = wrapStepOutput(stepResult.output);
      }
    } catch (err) {
      const duration_ms = Date.now() - stepStartedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Step ${stepNumber} failed`, { trace_type: "chain.step.end", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team, status: "failed", duration_ms, error_type: err instanceof Error ? err.name : typeof err, error_preview: sanitizeAgentInput(errorMsg).slice(0, 500) });
      throw err;
    }

    try {
    // --- Task 2 fix: synthesize stepResult from parallel results for retry loop ---
    const isIncomplete = stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED");
    const isParallelIncomplete = parallelResults?.some(r => r.grade === "FEEDBACK" || r.grade === "FAILED");

    if (isParallelIncomplete && !stepResult && parallelResults) {
      const grades = ["PERFECT", "VERIFIED", "PARTIAL", "FEEDBACK", "FAILED"];
      const worstResult = parallelResults.reduce((worst, r) => {
        return grades.indexOf(r.grade ?? "UNGRADED") > grades.indexOf(worst.grade ?? "UNGRADED") ? r : worst;
      });
      stepResult = { ...worstResult };
    }

    if ((isIncomplete || isParallelIncomplete) && (step.team || step.parallel) && process.env.MAE_CERTIFICATION_MODE !== "1") {
      const fb = step.on_feedback ?? { retry_team: step.team ?? step.parallel?.[0]?.team ?? "", max_attempts: 2, escalate_to: "user" };
      let attempts = 0;
      while (attempts < fb.max_attempts && stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
        attempts++;
        log.info("Retrying step", { attempt: attempts, max_attempts: fb.max_attempts, grade: stepResult.grade, session_id: session.id });
        await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `Retry ${attempts}/${fb.max_attempts}: re-running (grade: ${stepResult.grade}).`);

        const retryTeam = fb.retry_team || step.team || step.parallel?.[0]?.team || "";
        const retryStep: ChainStep = { team: retryTeam };
        const feedbackContext = `Previous attempt graded ${stepResult.grade}. Feedback/output:\n${stepResult.output}\n\nPlease address the issues and try again.`;
        stepResult = await runTeamStep(teamDeps, session, retryStep, task, feedbackContext, adapterName);
        previousOutput = stepResult.output;
      }
      if (stepResult && (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED")) {
        log.warn("Exhausted retries, escalating", { max_attempts: fb.max_attempts, escalate_to: fb.escalate_to, grade: stepResult.grade, session_id: session.id });
        await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
          `⚠️ Exhausted ${fb.max_attempts} feedback retries for step ${i + 1}. Escalation target: ${fb.escalate_to}. Grade: ${stepResult.grade}.`);
      }
    }

    let stepGrade = stepResult?.grade ?? (parallelResults ? worstGrade(parallelResults.map((r) => r.grade)) : undefined);

    let stepVerified = true;
    if (stepGrade !== "FAILED" && stepGrade !== "FEEDBACK") {
      if (step.till_done) {
        const stepOutput = stepResult?.output ?? parallelResults?.map(r => r.output).join("\n") ?? "";
        const { allMet, failures } = await verifyTillDone(deps.emitter, session, step, i, stepOutput, steps);
        if (!allMet) {
          stepVerified = false;
          await deps.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `Till-done verification failed:\n${failures.map(f => `- ${f}`).join("\n")}`);
          if (stepResult && stepResult.grade !== "FAILED" && stepResult.grade !== "FEEDBACK") {
            stepResult = { ...stepResult, grade: "FEEDBACK" };
          }
        }
      }
      stepGrade = stepResult?.grade ?? (parallelResults ? worstGrade(parallelResults.map((r) => r.grade)) : undefined);
    }

    // Update pipeline state after verification so dashboard grade matches the trace.
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

    if (stepVerified && stepGrade !== "FAILED" && stepGrade !== "FEEDBACK") {
      markTillDone(session, i, steps);
    }
    await deps.emitter.tillDone(session.id, session.name, session.tillDone);

    deps.orchestratorLoop?.trigger("agent_done", { step: i, grade: stepGrade });
    deps.orchestratorLoop?.recordEvent({
      session_id: session.id, agent_id: "orch-1",
      event_type: "step_complete", timestamp: new Date().toISOString(),
      data: { step: i, grade: stepGrade },
    });
    const certMode = process.env.MAE_CERTIFICATION_MODE === "1";
    const hardFail = stepGrade === "FAILED";
    const softFail = !stepVerified || stepGrade === "FEEDBACK";
    const stepStatus = (hardFail || (softFail && !certMode)) ? "failed" : softFail ? "degraded" : "completed";
    log.info(`Step ${stepNumber} ${stepStatus}`, { trace_type: "chain.step.end", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team, status: stepStatus, duration_ms: Date.now() - stepStartedAt });
    if (stepStatus === "degraded") {
      log.warn("Step degraded in certification mode", { session_id: session.id, step: stepNumber, grade: stepGrade, verified: stepVerified });
    }
    if (stepStatus === "failed") {
      throw new Error(`Chain step ${stepNumber} failed: ${stepLabel}`);
    }
    } catch (err) {
      const duration_ms = Date.now() - stepStartedAt;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Step ${stepNumber} failed`, { trace_type: "chain.step.end", session_id: session.id, step: stepNumber, name: stepLabel, team: step.team, status: "failed", duration_ms, error_type: err instanceof Error ? err.name : typeof err, error_preview: sanitizeAgentInput(errorMsg).slice(0, 500) });
      throw err;
    }
  }
}
