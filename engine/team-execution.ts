import {
  getTeam,
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModelForRole,
} from "./config";
import { delegateWithHealing } from "./self-healing";
import { isGitRepo, createWorktree, mergeWorktree, cleanupWorktree } from "./worktree";
import { parseAssignment, summarizeOutput } from "./output-parsing";
import { retryWorker, spawnSenior, leadReviewWorkers } from "./worker-lifecycle";
import type { EventEmitter } from "./event-emitter";
import type { SandboxPool } from "./sandbox-pool";
import { logPerformance } from "./perf-log";
import type {
  PlatformAdapter,
  DelegateOptions,
  DelegateResult,
  SessionState,
  ChainStep,
  GradeLevel,
} from "./types";

export interface TeamExecutionDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  sandboxPool: SandboxPool | null;
  trackActivity: (agentId: string, name: string, role: string) => void;
  trackToolCall: (agentId: string, tool: string) => void;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
  getAdapter: (name?: string) => PlatformAdapter;
}

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
  const { emitter, messageSenders, sandboxPool, trackActivity, trackToolCall, checkBudget, getAdapter } = deps;
  const teamConfig = getTeam(step.team!);
  const adapter = getAdapter(adapterName);
  const leadPersona = loadPersona(teamConfig.lead.path);
  const leadId = `${step.team}-lead`;

  console.log(`[orchestrator] Delegating to team: ${teamConfig["team-name"]}`);

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
    onStreamEvent: (streamEvt) => {
      if (streamEvt.type === "tool_call") {
        trackToolCall(leadId, streamEvt.tool ?? "");
        emitter.toolCall(session.id, leadId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
      } else if (streamEvt.type === "cost") {
        emitter.costUpdate(session.id, leadId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
      }
    },
    sendMessage: (fn) => {
      messageSenders.set(`${session.id}:${leadId}`, fn);
    },
  };

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
  await emitter.agentDone(session.id, leadId, leadResult.grade);

  if (leadResult.grade === "FAILED" || !teamConfig.members.length) {
    const msg = leadResult.grade === "FAILED"
      ? `${teamConfig["team-name"]} lead could not complete the task.`
      : `${teamConfig["team-name"]} complete (lead only).`;
    await emitter.message(session.id, "orch-1", "Orchestrator", "user", msg);
    return leadResult;
  }

  // Spawn workers in parallel -- each gets their assignment from the lead's brief
  const useWorktrees = teamConfig.members.length > 1 && await isGitRepo(session.workingDir);
  const workerWtIds: string[] = [];

  console.log(`[orchestrator] Lead briefed. Spawning ${teamConfig.members.length} workers: ${teamConfig.members.map((m) => m.name).join(", ")}`);
  await emitter.message(session.id, "orch-1", "Orchestrator", "user",
    `${teamConfig["team-name"]} lead assigned ${teamConfig.members.length} workers: ${teamConfig.members.map((m) => m.name).join(", ")}.`);

  const workerAssignments = new Map<string, string>();

  const workerPromises = teamConfig.members.map(async (member) => {
    const workerPersona = loadPersona(member.path);
    const workerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    trackActivity(workerId, member.name, "worker");

    let workerDir = session.workingDir;

    // Assign sandbox if pool is enabled
    const sandbox = sandboxPool ? await sandboxPool.assign(workerId) : null;
    if (sandbox) {
      console.log(`[orchestrator] Agent ${member.name} assigned to sandbox ${sandbox.id} (${sandbox.ip})`);
    }

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
      onStreamEvent: (streamEvt) => {
        if (streamEvt.type === "tool_call") {
          trackToolCall(workerId, streamEvt.tool ?? "");
          emitter.toolCall(session.id, workerId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
        } else if (streamEvt.type === "cost") {
          emitter.costUpdate(session.id, workerId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
        }
      },
      sendMessage: (fn) => {
        messageSenders.set(`${session.id}:${workerId}`, fn);
      },
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
      await emitter.agentDone(session.id, workerId, result.grade);

      return result;
    } finally {
      if (sandboxPool) await sandboxPool.release(workerId);
    }
  });

  const settled = await Promise.allSettled(workerPromises);

  // Worktree cleanup always runs, even if workers threw
  for (const wtId of workerWtIds) {
    try {
      const { merged, hadChanges } = await mergeWorktree(session.workingDir, wtId);
      if (hadChanges) {
        if (merged) {
          console.log(`[orchestrator] Merged worktree ${wtId} (had changes)`);
        } else {
          console.warn(`[orchestrator] WARN: Failed to merge worktree ${wtId} -- changes may be lost`);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    } catch (e) {
      console.error(`[orchestrator] Worktree cleanup failed for ${wtId}:`, e);
    }
  }

  // Accumulate costs sequentially after all workers complete — no parallel race
  const workerResults: DelegateResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      checkBudget(session, result.agentId, result.costUsd, result.tokensUsed);
      session.totalCost += result.costUsd;
      session.totalTokens += result.tokensUsed;
      workerResults.push(result);
    } else {
      console.error("[orchestrator] Worker failed:", outcome.reason);
    }
  }

  // Build worker lifecycle deps for review/retry
  const lifecycleDeps = {
    emitter,
    messageSenders,
    trackToolCall,
    checkBudget,
  };

  // Lead reviews worker output
  let reviews = await leadReviewWorkers(
    lifecycleDeps, session, teamConfig, leadPersona, workerResults,
    workerAssignments, task, adapter, step, leadId
  );

  // Retry loop: NEEDS_WORK workers get reworked prompts and retry
  const maxRetries = step.max_worker_retries ?? 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const needsWork = reviews.filter(r => r.grade === "NEEDS_WORK");
    if (needsWork.length === 0) break;

    console.log(`[orchestrator] Retry cycle ${attempt}/${maxRetries}: ${needsWork.length} workers need rework`);
    await emitter.message(session.id, leadId, "Orchestrator", "user",
      `Retry cycle ${attempt}/${maxRetries}: ${needsWork.map(r => r.workerName).join(", ")} need rework.`);

    for (const review of needsWork) {
      if (review.directFix) {
        console.log(`[orchestrator] ${review.workerName}: lead applying direct fix`);
        await emitter.message(session.id, leadId, teamConfig.lead.name, "user",
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

  const allPass = reviews.every(r => r.grade === "PASS");
  const reviewGrade: GradeLevel = allPass ? "VERIFIED" : "FAILED";
  const combinedOutput = workerResults.map((r) => `[${r.agentName}]:\n${r.output}`).join("\n\n---\n\n");
  const totalCost = leadResult.costUsd + workerResults.reduce((s, r) => s + r.costUsd, 0);

  await emitter.message(session.id, "orch-1", "Orchestrator", "user",
    `${teamConfig["team-name"]} complete. Lead reviewed ${reviews.length} workers: ${reviews.map(r => `${r.workerName}=${r.grade}`).join(", ")}. Grade: ${reviewGrade}. Cost: $${totalCost.toFixed(3)}.`);

  return {
    agentId: leadId,
    agentName: teamConfig.lead.name,
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
  console.log(`[orchestrator] Running ${teams.length} teams in parallel: ${teams.map((t) => t.team).join(", ")}`);

  const useWorktrees = teams.length > 1 && await isGitRepo(session.workingDir);
  const teamWtIds: string[] = [];

  const promises = teams.map(async (t, idx) => {
    const teamSession: SessionState = useWorktrees ? {
      ...session,
      agents: new Map(session.agents),
      tillDone: session.tillDone.map(item => ({ ...item })),
      events: [...session.events],
    } : session;
    if (useWorktrees) {
      const wtId = `${session.id.slice(0, 8)}-team-${idx}`;
      teamSession.workingDir = await createWorktree(session.workingDir, wtId);
      teamWtIds.push(wtId);
      console.log(`[orchestrator] Created team worktree for ${t.team}: ${teamSession.workingDir}`);
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
          console.log(`[orchestrator] Merged team worktree ${wtId} (had changes)`);
        } else {
          console.warn(`[orchestrator] WARN: Failed to merge team worktree ${wtId} -- changes may be lost`);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    } catch (e) {
      console.error(`[orchestrator] Team worktree cleanup failed for ${wtId}:`, e);
    }
  }

  const results: DelegateResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      console.error("[orchestrator] Parallel team failed:", outcome.reason);
    }
  }

  // Synthesize parallel results into unified report
  const { emitter, getAdapter, trackToolCall: trackTool, checkBudget: budgetCheck, messageSenders } = deps;
  const allTeams = loadTeams();
  const synthPersona = loadPersona(allTeams.orchestrator.path);
  const synthResolved = resolveModelForRole("orchestrator");
  const synthId = `synth-${session.id.slice(0, 8)}`;
  const adapter = getAdapter(adapterName);

  console.log(`[orchestrator] Synthesizing ${results.length} parallel team outputs`);

  await emitter.agentSpawn(session.id, synthId, "orch-1", "Synthesis", "orchestrator",
    synthResolved.model, "Synthesis", "#a855f7");

  const teamOutputs = results.map((r, i) =>
    `### Team: ${teams[i]?.team ?? `Team ${i + 1}`}\nGrade: ${r.grade ?? "UNGRADED"}\n\n${r.output}`
  ).join("\n\n---\n\n");

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
    onStreamEvent: (streamEvt) => {
      if (streamEvt.type === "tool_call") {
        trackTool(synthId, streamEvt.tool ?? "");
        emitter.toolCall(session.id, synthId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
      } else if (streamEvt.type === "cost") {
        emitter.costUpdate(session.id, synthId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
      }
    },
    sendMessage: (fn) => {
      messageSenders.set(`${session.id}:${synthId}`, fn);
    },
  };

  const synthResult = await adapter.delegate(synthOpts);
  await emitter.costUpdate(session.id, synthId, synthResult.costUsd, synthResult.tokensUsed, 0);
  budgetCheck(session, synthId, synthResult.costUsd, synthResult.tokensUsed);
  session.totalCost += synthResult.costUsd;
  session.totalTokens += synthResult.tokensUsed;

  const synthSummary = summarizeOutput(synthResult.output, 2000);
  await emitter.message(session.id, synthId, "Synthesis", "user", synthSummary);
  await emitter.agentDone(session.id, synthId, synthResult.grade ?? "VERIFIED");

  return [{
    ...synthResult,
    agentName: "Synthesis",
    agentId: synthId,
  }];
}
