import {
  loadPersona,
  loadExpertise,
  loadTeams,
  buildSystemPrompt,
  loadPreamble,
  resolveModelForRole,
} from "./config";
import { createLogger } from "./logger";
import { logPerformance } from "./perf-log";

const log = createLogger("worker-lifecycle");
import { delegateWithHealing } from "./self-healing";
import { summarizeOutput } from "./output-parsing";
import { parseReviews } from "./output-parsing";
import { buildStreamHandler, buildSendMessage } from "./stream-handler";
import { buildWorkerSystemPromptAppend, isReviewOnlyStep, readOnlyTools } from "./review-mode";
import { buildParticipantCapabilities } from "./participant-capabilities";
import type { EventEmitter } from "./event-emitter";
import type { OrchestratorLoop } from "./orchestrator-loop";
import type {
  PlatformAdapter,
  DelegateOptions,
  DelegateResult,
  SessionState,
  TeamConfig,
  TeamMember,
  PersonaConfig,
  ChainStep,
  WorkerReview,
} from "./types";

export interface WorkerLifecycleDeps {
  emitter: EventEmitter;
  messageSenders: Map<string, (msg: string) => void>;
  trackToolCall: (agentId: string, tool: string) => void;
  checkBudget: (session: SessionState, agentId: string, agentCost: number, agentTokens: number) => void;
  orchestratorLoop?: OrchestratorLoop | null;
  pausedSessions?: Set<string>;
}

function assertSessionActive(session: SessionState, phase: string): void {
  if (session.status === "error" || session.abortSignal?.aborted === true) {
    throw new Error(`Session stopped by user during ${phase}`);
  }
}

/**
 * Retry a worker with a reworked prompt from the lead's review.
 */
export async function retryWorker(
  deps: WorkerLifecycleDeps,
  session: SessionState,
  teamConfig: TeamConfig,
  member: TeamMember,
  reworkedPrompt: string,
  task: string,
  adapter: PlatformAdapter,
  leadId: string,
  attempt: number,
  step: ChainStep,
): Promise<DelegateResult> {
  const { emitter, messageSenders, trackToolCall, checkBudget, orchestratorLoop, pausedSessions } = deps;
  assertSessionActive(session, "worker retry");
  const workerPersona = loadPersona(member.path);
  const baseWorkerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const workerId = `${baseWorkerId}-retry-${attempt}`;

  log.info("Retrying worker with reworked prompt", { worker: member.name, attempt, session_id: session.id });

  const retryResolved = resolveModelForRole("worker", member.model);
  const reviewOnly = isReviewOnlyStep(step);
  const workerDomain = reviewOnly ? { ...workerPersona.domain, write: [], update: [] } : workerPersona.domain;
  const workerTools = reviewOnly ? readOnlyTools(workerPersona.tools) : workerPersona.tools;

  await emitter.agentSpawn(session.id, workerId, leadId, `${member.name} (retry ${attempt})`, "worker",
    retryResolved.model, teamConfig["team-name"], member.color ?? teamConfig["team-color"], undefined,
    buildParticipantCapabilities({
      tools: workerTools, domain: workerDomain, model: retryResolved.model,
    }));

  const retryUserPrompt = [
    `RETRY (attempt ${attempt}): Your previous output was reviewed and needs rework.`,
    ``,
    `**Reworked assignment from ${teamConfig.lead.name}:**`,
    reworkedPrompt,
    ``,
    `**Original task:** ${task}`,
  ].join("\n");

  await emitter.message(session.id, workerId, teamConfig.lead.name, "user",
    `📋 **Retry assignment to ${member.name} (attempt ${attempt}):**\n\n${retryUserPrompt.slice(0, 3000)}`);

  const workerSystemPromptAppend = buildWorkerSystemPromptAppend(step.system_prompt_append);
  const workerOpts: DelegateOptions = {
    persona: workerPersona,
    systemPrompt: workerSystemPromptAppend
      ? buildSystemPrompt(workerPersona, "worker") + "\n\n" + workerSystemPromptAppend
      : buildSystemPrompt(workerPersona, "worker"),
    userPrompt: retryUserPrompt,
    model: retryResolved.model,
    thinking: retryResolved.thinking,
    tools: workerTools,
    domain: workerDomain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: leadId,
    teamName: teamConfig["team-name"],
    teamColor: member.color ?? teamConfig["team-color"],
    abortSignal: session.abortSignal,
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId: workerId,
      trackToolCall, messageSenders, orchestratorLoop, pausedSessions, session,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, workerId),
  };

  const retryStartTime = Date.now();
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
  checkBudget(session, workerId, result.costUsd, result.tokensUsed);
  session.totalCost += result.costUsd;
  session.totalTokens += result.tokensUsed;

  logPerformance({
    model: retryResolved.model,
    role: "worker-retry",
    grade: result.grade ?? "UNGRADED",
    cost_usd: result.costUsd,
    latency_ms: Date.now() - retryStartTime,
    findings_count: result.findings?.length ?? 0,
    agent_name: member.name,
    session_id: session.id,
    timestamp: new Date().toISOString(),
  });

  const workerSummary = summarizeOutput(result.output, 1500);
  await emitter.message(session.id, workerId, member.name, "user", workerSummary);
  await emitter.agentDone(session.id, workerId, result.grade, result.costUsd, {
    outputArtifact: result.outputArtifact,
    taskReport: result.taskReport,
  });

  return result;
}

/**
 * Spawn a Senior agent that combines expertise from multiple domains
 * to handle tasks that require cross-domain knowledge.
 */
export async function spawnSenior(
  deps: WorkerLifecycleDeps,
  session: SessionState,
  teamConfig: TeamConfig,
  failedReview: WorkerReview,
  task: string,
  adapter: PlatformAdapter,
  leadId: string,
  step: ChainStep,
): Promise<DelegateResult> {
  const { emitter, messageSenders, trackToolCall, checkBudget, orchestratorLoop, pausedSessions } = deps;
  assertSessionActive(session, "senior spawn");
  const domainNames = failedReview.srDomains ?? [];
  const srId = `${step.team}-sr-${domainNames.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  log.info("Spawning Sr. agent", { worker: failedReview.workerName, domains: domainNames, session_id: session.id });

  // Find and load personas for each domain
  const memberPersonas = domainNames.map(name => {
    const member = teamConfig.members.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (member) return loadPersona(member.path);
    // Try matching across all teams' members
    const teams = loadTeams();
    for (const t of teams.teams) {
      const m = t.members.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (m) return loadPersona(m.path);
    }
    return null;
  }).filter((p): p is PersonaConfig => p !== null);

  if (memberPersonas.length === 0) {
    log.warn("No personas found for Sr. domains", { domains: domainNames, session_id: session.id });
    return {
      agentId: srId, agentName: `Sr. (${domainNames.join("+")})`,
      output: "ERROR: Could not find personas for requested domains",
      grade: "FAILED", findings: ["sr_domain_not_found"], costUsd: 0, tokensUsed: 0,
    };
  }

  // Merge domain access, tools, expertise, and body text
  const mergedRead = [...new Set(memberPersonas.flatMap(p => p.domain.read))];
  const mergedWrite = [...new Set(memberPersonas.flatMap(p => p.domain.write))];
  const mergedUpdate = [...new Set(memberPersonas.flatMap(p => p.domain.update))];
  const mergedTools = [...new Set(memberPersonas.flatMap(p => p.tools))];
  const mergedExpertise = memberPersonas.map(p => loadExpertise(p.expertise)).filter(Boolean).join("\n\n---\n\n");
  const mergedBody = memberPersonas.map(p => p.body ?? "").filter(Boolean).join("\n\n---\n\n");

  const srPreamble = loadPreamble("sr");
  const reviewOnly = isReviewOnlyStep(step);
  const srTools = reviewOnly ? readOnlyTools(mergedTools) : mergedTools;
  const srDomain = reviewOnly ? { read: mergedRead, write: [], update: [] } : { read: mergedRead, write: mergedWrite, update: mergedUpdate };
  const srSystemPrompt = [
    srPreamble,
    "",
    `# Sr. Engineer (${domainNames.join(" + ")})`,
    "",
    `You are a Senior agent combining expertise from: ${domainNames.join(", ")}.`,
    `Model: quality | Tools: ${mergedTools.join(", ")}`,
    "",
    mergedBody ? `## Instructions\n\n${mergedBody}` : "",
    "",
    "## Domain",
    `Read: ${mergedRead.join(", ")}`,
    `Write: ${mergedWrite.join(", ")}`,
    "",
    mergedExpertise ? `## Combined Expertise\n\n${mergedExpertise}` : "",
    reviewOnly ? buildWorkerSystemPromptAppend(step.system_prompt_append) : "",
  ].filter(Boolean).join("\n");

  const srPrompt = [
    `A worker (${failedReview.workerName}) could not complete this task because it requires cross-domain knowledge.`,
    ``,
    `**Original task:** ${task}`,
    ``,
    `**Lead's feedback on the failed attempt:**`,
    failedReview.feedback ?? "(no feedback)",
    ``,
    `Complete the task using your combined domain expertise.`,
  ].join("\n");

  const srResolved = resolveModelForRole("sr");

  await emitter.agentSpawn(session.id, srId, leadId,
    `Sr. (${domainNames.join("+")})`, "sr",
    srResolved.model, teamConfig["team-name"], "#ffaa00", undefined,
    buildParticipantCapabilities({
      tools: srTools, domain: srDomain, model: srResolved.model, authority: 55,
    }));

  await emitter.message(session.id, srId, teamConfig.lead.name, "user",
    `📋 **Sr. assignment (${domainNames.join("+")})**:\n\n${srPrompt.slice(0, 3000)}`);

  const srOpts: DelegateOptions = {
    persona: { ...memberPersonas[0]!, name: `Sr. (${domainNames.join("+")})`, body: mergedBody },
    systemPrompt: srSystemPrompt,
    userPrompt: srPrompt,
    model: srResolved.model,
    thinking: srResolved.thinking,
    tools: srTools,
    domain: srDomain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: leadId,
    teamName: teamConfig["team-name"],
    teamColor: "#ffaa00",
    abortSignal: session.abortSignal,
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId: srId,
      trackToolCall, messageSenders, orchestratorLoop, pausedSessions, session,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, srId),
  };

  const srStartTime = Date.now();
  const result = await delegateWithHealing({
    adapter, opts: srOpts, sessionId: session.id, agentRole: "sr",
    onEvent: async (_type, data) => {
      await emitter.selfHeal(session.id, srId, data.failed_worker as string, data.heal_action as string);
    },
  });

  await emitter.costUpdate(session.id, srId, result.costUsd, result.tokensUsed, 0);
  checkBudget(session, srId, result.costUsd, result.tokensUsed);
  session.totalCost += result.costUsd;
  session.totalTokens += result.tokensUsed;

  logPerformance({
    model: srResolved.model,
    role: "sr",
    grade: result.grade ?? "UNGRADED",
    cost_usd: result.costUsd,
    latency_ms: Date.now() - srStartTime,
    findings_count: result.findings?.length ?? 0,
    agent_name: `Sr. (${domainNames.join("+")})`,
    session_id: session.id,
    timestamp: new Date().toISOString(),
  });

  const srSummary = summarizeOutput(result.output, 2000);
  await emitter.message(session.id, srId, `Sr. (${domainNames.join("+")})`, "user", srSummary);
  await emitter.agentDone(session.id, srId, result.grade, result.costUsd, {
    outputArtifact: result.outputArtifact,
    taskReport: result.taskReport,
  });

  return result;
}

/**
 * Have the lead review worker outputs and produce structured review grades.
 */
export async function leadReviewWorkers(
  deps: WorkerLifecycleDeps,
  session: SessionState,
  teamConfig: TeamConfig,
  leadPersona: PersonaConfig,
  workerResults: DelegateResult[],
  workerAssignments: Map<string, string>,
  task: string,
  adapter: PlatformAdapter,
  step: ChainStep,
  leadId: string,
): Promise<WorkerReview[]> {
  const { emitter, messageSenders, trackToolCall, orchestratorLoop, pausedSessions } = deps;
  assertSessionActive(session, "lead review");

  log.info("Lead reviewing workers", { lead: teamConfig.lead.name, worker_count: workerResults.length, session_id: session.id });

  await emitter.message(session.id, leadId, "Orchestrator", "user",
    `${teamConfig.lead.name} is now reviewing worker output.`);

  const reviewSections = workerResults.map((r) => {
    const assignment = workerAssignments.get(r.agentId) ?? "(full brief)";
    const output = r.output.length > 3000 ? r.output.slice(0, 3000) + "\n...(truncated)" : r.output;
    return [
      `### Worker: ${r.agentName} (${r.agentId})`,
      `**Assignment you gave them:**`,
      assignment,
      ``,
      `**Their output:**`,
      output,
    ].join("\n");
  });

  const reviewPrompt = [
    `You assigned work to your team. Now review each worker's output against the original task.`,
    ``,
    `**Original task:** ${task}`,
    ``,
    ...reviewSections,
    ``,
    `---`,
    ``,
    `For each worker, respond with this exact format:`,
    ``,
    `### REVIEW: [worker name]`,
    `GRADE: PASS | NEEDS_WORK`,
    `FEEDBACK: [what needs to change -- only if NEEDS_WORK]`,
    `REWORKED_PROMPT: [rewritten assignment for retry -- only if NEEDS_WORK]`,
    `DIRECT_FIX: [your fix if the issue is trivial and you can fix it yourself -- only if NEEDS_WORK]`,
    `SPAWN_SR: [persona1, persona2] -- if the task needs cross-domain knowledge a single worker can't provide`,
    `QUALITY_NOTE: [anything that works but could be cleaner -- optional, not a blocker]`,
    ``,
    `PASS means the output fully meets the assignment. No partial passes.`,
    `If the output works correctly but could be cleaner/better, use QUALITY_NOTE.`,
    `If a worker needs knowledge from multiple domains (e.g. frontend + backend), use SPAWN_SR with the persona names to combine.`,
  ].join("\n");

  const reviewSystemPrompt = step.system_prompt_append
    ? buildSystemPrompt(leadPersona, "lead") + "\n\n" + step.system_prompt_append
    : buildSystemPrompt(leadPersona, "lead");

  const reviewResolved = resolveModelForRole("lead", teamConfig.lead.model);

  const reviewOpts: DelegateOptions = {
    persona: leadPersona,
    systemPrompt: reviewSystemPrompt,
    userPrompt: reviewPrompt,
    model: reviewResolved.model,
    thinking: reviewResolved.thinking,
    tools: ["read", "grep", "glob", "find"],
    domain: leadPersona.domain,
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: "orch-1",
    teamName: teamConfig["team-name"],
    teamColor: teamConfig["team-color"],
    abortSignal: session.abortSignal,
    onStreamEvent: buildStreamHandler({
      emitter, sessionId: session.id, agentId: leadId,
      trackToolCall, messageSenders, orchestratorLoop, pausedSessions, session,
    }),
    sendMessage: buildSendMessage(messageSenders, session.id, leadId),
  };

  const reviewResult = await adapter.delegate(reviewOpts);
  session.totalCost += reviewResult.costUsd;
  session.totalTokens += reviewResult.tokensUsed;
  await emitter.costUpdate(session.id, leadId, reviewResult.costUsd, reviewResult.tokensUsed, 0);

  const reviewSummary = summarizeOutput(reviewResult.output, 2000);
  await emitter.message(session.id, leadId, teamConfig.lead.name, "user",
    `📋 **Review complete:**\n\n${reviewSummary}`);

  return parseReviews(reviewResult.output, workerResults);
}
