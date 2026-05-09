import {
  loadPersona,
  loadExpertise,
  loadTeams,
  buildSystemPrompt,
  loadPreamble,
  resolveModelForRole,
} from "./config";
import { delegateWithHealing } from "./self-healing";
import { summarizeOutput } from "./output-parsing";
import { parseReviews } from "./output-parsing";
import type { EventEmitter } from "./event-emitter";
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
  checkBudget: (session: SessionState, agentId: string, agentCost: number) => void;
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
  const { emitter, messageSenders, trackToolCall, checkBudget } = deps;
  const workerPersona = loadPersona(member.path);
  const workerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  console.log(`[orchestrator] Retrying ${member.name} (attempt ${attempt}) with reworked prompt`);

  const retryResolved = resolveModelForRole("worker", member.model);

  await emitter.agentSpawn(session.id, workerId, leadId, `${member.name} (retry ${attempt})`, "worker",
    retryResolved.model, teamConfig["team-name"], member.color ?? teamConfig["team-color"]);

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

  const workerOpts: DelegateOptions = {
    persona: workerPersona,
    systemPrompt: buildSystemPrompt(workerPersona, "worker"),
    userPrompt: retryUserPrompt,
    model: retryResolved.model,
    thinking: retryResolved.thinking,
    tools: workerPersona.tools,
    domain: workerPersona.domain,
    workingDir: session.workingDir,
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

  const result = await delegateWithHealing({
    adapter,
    opts: workerOpts,
    sessionId: session.id,
    agentRole: "worker",
    onEvent: async (_type, data) => {
      await emitter.selfHeal(session.id, workerId, data.failed_worker as string, data.heal_action as string);
    },
  });

  session.totalCost += result.costUsd;
  session.totalTokens += result.tokensUsed;
  await emitter.costUpdate(session.id, workerId, result.costUsd, result.tokensUsed, 0);
  checkBudget(session, workerId, result.costUsd);

  const workerSummary = summarizeOutput(result.output, 1500);
  await emitter.message(session.id, workerId, member.name, "user", workerSummary);
  await emitter.agentDone(session.id, workerId, result.grade);

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
  const { emitter, messageSenders, trackToolCall, checkBudget } = deps;
  const domainNames = failedReview.srDomains ?? [];
  const srId = `${step.team}-sr-${domainNames.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  console.log(`[orchestrator] Spawning Sr. for ${failedReview.workerName} -- combining domains: ${domainNames.join(", ")}`);

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
    console.warn(`[orchestrator] No personas found for Sr. domains: ${domainNames.join(", ")}`);
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
    srResolved.model, teamConfig["team-name"], "#ffaa00");

  await emitter.message(session.id, srId, teamConfig.lead.name, "user",
    `📋 **Sr. assignment (${domainNames.join("+")})**:\n\n${srPrompt.slice(0, 3000)}`);

  const srOpts: DelegateOptions = {
    persona: { ...memberPersonas[0]!, name: `Sr. (${domainNames.join("+")})`, body: mergedBody },
    systemPrompt: srSystemPrompt,
    userPrompt: srPrompt,
    model: srResolved.model,
    thinking: srResolved.thinking,
    tools: mergedTools,
    domain: { read: mergedRead, write: mergedWrite, update: mergedUpdate },
    workingDir: session.workingDir,
    sessionDir: `data/sessions/${session.id}`,
    parentId: leadId,
    teamName: teamConfig["team-name"],
    teamColor: "#ffaa00",
    onStreamEvent: (streamEvt) => {
      if (streamEvt.type === "tool_call") {
        trackToolCall(srId, streamEvt.tool ?? "");
        emitter.toolCall(session.id, srId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running", streamEvt.toolArgs, streamEvt.toolResult);
      } else if (streamEvt.type === "cost") {
        emitter.costUpdate(session.id, srId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
      }
    },
    sendMessage: (fn) => {
      messageSenders.set(`${session.id}:${srId}`, fn);
    },
  };

  const result = await delegateWithHealing({
    adapter, opts: srOpts, sessionId: session.id, agentRole: "sr",
    onEvent: async (_type, data) => {
      await emitter.selfHeal(session.id, srId, data.failed_worker as string, data.heal_action as string);
    },
  });

  session.totalCost += result.costUsd;
  session.totalTokens += result.tokensUsed;
  await emitter.costUpdate(session.id, srId, result.costUsd, result.tokensUsed, 0);
  checkBudget(session, srId, result.costUsd);

  const srSummary = summarizeOutput(result.output, 2000);
  await emitter.message(session.id, srId, `Sr. (${domainNames.join("+")})`, "user", srSummary);
  await emitter.agentDone(session.id, srId, result.grade);

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
  const { emitter, messageSenders, trackToolCall } = deps;

  console.log(`[orchestrator] ${teamConfig.lead.name} reviewing ${workerResults.length} workers`);

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

  const reviewResult = await adapter.delegate(reviewOpts);
  session.totalCost += reviewResult.costUsd;
  session.totalTokens += reviewResult.tokensUsed;
  await emitter.costUpdate(session.id, leadId, reviewResult.costUsd, reviewResult.tokensUsed, 0);

  const reviewSummary = summarizeOutput(reviewResult.output, 2000);
  await emitter.message(session.id, leadId, teamConfig.lead.name, "user",
    `📋 **Review complete:**\n\n${reviewSummary}`);

  return parseReviews(reviewResult.output, workerResults);
}
