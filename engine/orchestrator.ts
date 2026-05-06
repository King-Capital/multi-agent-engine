import { randomUUID } from "crypto";
import {
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModel,
  getChain,
  getTeam,
  loadPrompt,
  loadModelRouting,
} from "./config";
import { EventEmitter } from "./event-emitter";
import { sanitizeAgentInput, validateAgentOutput } from "./security";
import { isGitRepo, createWorktree, mergeWorktree, cleanupWorktree } from "./worktree";
import { delegateWithHealing } from "./self-healing";
import type {
  PlatformAdapter,
  DelegateResult,
  DelegateOptions,
  Chain,
  ChainStep,
  SessionState,
  TillDoneItem,
} from "./types";

interface AgentActivity {
  agentId: string;
  name: string;
  role: string;
  lastEventAt: number;
  toolCalls: number;
  lastTool: string;
  warned: boolean;
}

const IDLE_WARN_MS = 90_000;
const MONITOR_INTERVAL_MS = 15_000;

export class Orchestrator {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private defaultAdapter: string = "";
  private emitter: EventEmitter;
  private dashboardUrl: string;
  private sessions: Map<string, SessionState> = new Map();
  private agentActivity: Map<string, AgentActivity> = new Map();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private messageSenders: Map<string, (msg: string) => void> = new Map();
  private sseAbort: AbortController | null = null;

  constructor(dashboardUrl?: string, apiToken?: string) {
    this.dashboardUrl = dashboardUrl ?? "http://localhost:8400";
    this.emitter = new EventEmitter(dashboardUrl, apiToken);
  }

  private trackActivity(agentId: string, name: string, role: string): void {
    this.agentActivity.set(agentId, {
      agentId, name, role,
      lastEventAt: Date.now(),
      toolCalls: 0,
      lastTool: "",
      warned: false,
    });
  }

  private trackToolCall(agentId: string, tool: string): void {
    const a = this.agentActivity.get(agentId);
    if (a) {
      a.lastEventAt = Date.now();
      a.toolCalls++;
      a.lastTool = tool;
      a.warned = false;
    }
  }

  private startMonitor(sessionId: string): void {
    if (this.monitorInterval) return;
    let tick = 0;
    this.monitorInterval = setInterval(() => {
      const now = Date.now();
      tick++;
      const isHeartbeat = tick % 2 === 0;

      for (const [id, a] of this.agentActivity) {
        const idle = now - a.lastEventAt;

        if (idle > IDLE_WARN_MS && !a.warned) {
          console.warn(`[monitor] IDLE: ${a.name} (${id}) -- ${Math.round(idle / 1000)}s`);
          a.warned = true;
        }

        if (isHeartbeat) {
          const status = idle > IDLE_WARN_MS ? "idle" : "working";
          console.log(`[heartbeat] ${a.name} (${a.role}): ${status} | ${a.toolCalls} tools | last: ${a.lastTool || "none"} | idle: ${Math.round(idle / 1000)}s`);
        }
      }
    }, MONITOR_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.agentActivity.clear();
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
    // Forward to the orchestrator's lead RPC session (first available sender)
    for (const [key, sender] of this.messageSenders) {
      if (key.startsWith(sessionId)) {
        sender(message);
        return;
      }
    }
  }

  private listenForUserMessages(sessionId: string): void {
    this.sseAbort = new AbortController();
    const url = `${this.dashboardUrl}/api/sessions/${sessionId}/stream`;
    const RETRY_DELAY_MS = 3_000;

    const connect = () => {
      if (!this.sseAbort || this.sseAbort.signal.aborted) return;
      fetch(url, { signal: this.sseAbort.signal }).then(async (res) => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let lineEnd: number;
          while ((lineEnd = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);

            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:") && currentEvent === "message") {
              try {
                const evt = JSON.parse(line.slice(5));
                if (evt.data?.from === "user" && evt.data?.content) {
                  console.log(`[orchestrator] User message: ${evt.data.content.slice(0, 80)}`);
                  this.sendUserMessage(sessionId, evt.data.content);
                }
              } catch { /* not JSON */ }
            } else if (line === "") {
              currentEvent = "";
            }
          }
        }

        if (!this.sseAbort?.signal.aborted) {
          console.log(`[orchestrator] SSE stream ended, reconnecting in ${RETRY_DELAY_MS}ms`);
          setTimeout(connect, RETRY_DELAY_MS);
        }
      }).catch((err) => {
        if (this.sseAbort?.signal.aborted) return;
        console.warn(`[orchestrator] SSE connection failed, retrying in ${RETRY_DELAY_MS}ms:`, err.message ?? err);
        setTimeout(connect, RETRY_DELAY_MS);
      });
    };

    connect();
  }

  private stopListening(): void {
    this.sseAbort?.abort();
    this.sseAbort = null;
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

    await this.emitter.sessionStart(sessionId, sessionName, chainName, opts.task);
    await this.emitter.pgCreateSession({ id: sessionId, name: sessionName, chain: chainName, team: chainName });

    const teams = loadTeams();
    const orchPersona = loadPersona(teams.orchestrator.path);
    await this.emitter.agentSpawn(sessionId, "orch-1", "", orchPersona.name, "orchestrator",
      resolveModel(teams.orchestrator.model), "Orchestration", teams.orchestrator.color ?? "#36f9f6");
    await this.emitter.pgCreateAgent({ sessionId, agentId: "orch-1", role: "orchestrator", persona: orchPersona.name });

    console.log(`\n[orchestrator] Session: ${sessionName}`);
    console.log(`[orchestrator] Chain: ${chainName}`);
    console.log(`[orchestrator] Dashboard: http://localhost:8400/session/${sessionId}`);
    console.log(`[orchestrator] Task: ${opts.task}\n`);

    this.loadBudgets();
    this.budgetWarned = false;
    await this.emitter.tillDone(sessionId, sessionName, session.tillDone);
    this.startMonitor(sessionId);
    this.listenForUserMessages(sessionId);

    try {
      await this.runChain(session, chain, taskBody, opts.adapter);
      session.status = "completed";
    } catch (err) {
      session.status = "error";
      console.error(`[orchestrator] Session failed:`, err);
      await this.emitter.pgUpdateSession(sessionId, { status: "failed" });
    }

    this.stopMonitor();
    this.stopListening();
    const prefix = `${sessionId}:`;
    for (const key of this.messageSenders.keys()) {
      if (key.startsWith(prefix)) this.messageSenders.delete(key);
    }
    await this.emitter.sessionEnd(sessionId);
    console.log(`\nSession ${sessionId} ${session.status}. Cost: $${session.totalCost.toFixed(3)}`);
    return session;
  }

  private async runChain(session: SessionState, chain: Chain, task: string, adapterName?: string): Promise<void> {
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    let previousOutput = "";
    let stepResult: DelegateResult | undefined;
    let parallelResults: DelegateResult[] | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      const stepLabel = step.team ?? step.agent ?? "parallel teams";
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Starting step ${i + 1}/${steps.length}: ${stepLabel}.`);

      if (step.parallel) {
        parallelResults = await this.runParallelStep(session, step, task, previousOutput, adapterName);
        previousOutput = parallelResults.map((r) => `[${r.agentName}]: ${r.output}`).join("\n\n");
      } else if (step.team) {
        stepResult = await this.runTeamStep(session, step, task, previousOutput, adapterName);
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
          stepResult = await this.runTeamStep(session, retryStep, task, feedbackContext, adapterName);
          previousOutput = stepResult.output;
        }
        if (stepResult.grade === "FEEDBACK" || stepResult.grade === "FAILED") {
          console.warn(`[orchestrator] on_feedback exhausted ${fb.max_attempts} retries. Escalating to: ${fb.escalate_to}`);
          await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
            `⚠️ Exhausted ${fb.max_attempts} feedback retries for step ${i + 1}. Escalation target: ${fb.escalate_to}. Grade: ${stepResult.grade}.`);
        }
      }

      // Issue #65: Only mark till_done if the step didn't FAIL
      const stepGrade = stepResult?.grade ?? (parallelResults ? this.worstGrade(parallelResults.map((r) => r.grade)) : undefined);
      if (stepGrade !== "FAILED") {
        this.markTillDone(session, i);
      }
      await this.emitter.tillDone(session.id, session.name, session.tillDone);
    }
  }

  private normalizeParallelChain(chain: Chain): ChainStep[] {
    const steps: ChainStep[] = [];
    if (chain.parallel) steps.push({ parallel: chain.parallel });
    if (chain.then) steps.push(...chain.then);
    return steps;
  }

  private async runTeamStep(
    session: SessionState, step: ChainStep, task: string,
    previousOutput: string, adapterName?: string
  ): Promise<DelegateResult> {
    const teamConfig = getTeam(step.team!);
    const adapter = this.getAdapter(adapterName);
    const leadPersona = loadPersona(teamConfig.lead.path);
    const leadId = `${step.team}-lead`;

    console.log(`[orchestrator] Delegating to team: ${teamConfig["team-name"]}`);

    this.trackActivity(leadId, teamConfig.lead.name, "lead");

    await this.emitter.agentSpawn(session.id, leadId, "orch-1", teamConfig.lead.name, "lead",
      resolveModel(teamConfig.lead.model), teamConfig["team-name"], teamConfig["team-color"]);

    // Lead gets the task + team roster — produces a briefing for workers
    const members = teamConfig.members.map((m) => `- ${m.name}: ${m["consult-when"] ?? "general tasks"}`).join("\n");
    const leadPrompt = [
      `Task: ${task}`,
      previousOutput ? `\nContext from previous step:\n${previousOutput}` : "",
      `\nYour team:\n${members}`,
      `\nBrief each worker with specific assignments. Use this format for each:`,
      ...teamConfig.members.map((m) => `\n### ASSIGNMENT: ${m.name}\n[What this worker should focus on, which files to review, what to look for]`),
      step.till_done ? `\nTill done:\n${step.till_done.map((t) => `- [ ] ${t}`).join("\n")}` : "",
    ].join("\n");

    const leadOpts: DelegateOptions = {
      persona: leadPersona,
      systemPrompt: buildSystemPrompt(leadPersona),
      userPrompt: leadPrompt,
      model: resolveModel(teamConfig.lead.model),
      thinking: "high" as const,
      tools: leadPersona.tools,
      domain: leadPersona.domain,
      workingDir: session.workingDir,
      sessionDir: `data/sessions/${session.id}`,
      parentId: "orch-1",
      teamName: teamConfig["team-name"],
      teamColor: teamConfig["team-color"],
      onStreamEvent: (streamEvt) => {
        if (streamEvt.type === "tool_call") {
          this.trackToolCall(leadId, streamEvt.tool ?? "");
          this.emitter.toolCall(session.id, leadId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running");
        } else if (streamEvt.type === "cost") {
          this.emitter.costUpdate(session.id, leadId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
        }
      },
      sendMessage: (fn) => {
        this.messageSenders.set(`${session.id}:${leadId}`, fn);
      },
    };

    const leadResult = await adapter.delegate(leadOpts);
    session.totalCost += leadResult.costUsd;
    session.totalTokens += leadResult.tokensUsed;
    await this.emitter.costUpdate(session.id, leadId, leadResult.costUsd, leadResult.tokensUsed, 0);
    this.checkBudget(session, leadId, leadResult.costUsd);

    if (leadResult.grade === "FAILED" || !teamConfig.members.length) {
      const msg = leadResult.grade === "FAILED"
        ? `${teamConfig["team-name"]} lead could not complete the task.`
        : `${teamConfig["team-name"]} complete (lead only).`;
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user", msg);
      return leadResult;
    }

    // Spawn workers in parallel — each gets their assignment from the lead's brief
    const useWorktrees = teamConfig.members.length > 1 && await isGitRepo(session.workingDir);
    const workerWtIds: string[] = [];

    console.log(`[orchestrator] Lead briefed. Spawning ${teamConfig.members.length} workers: ${teamConfig.members.map((m) => m.name).join(", ")}`);
    await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `${teamConfig["team-name"]} lead assigned ${teamConfig.members.length} workers: ${teamConfig.members.map((m) => m.name).join(", ")}.`);

    const workerPromises = teamConfig.members.map(async (member) => {
      const workerPersona = loadPersona(member.path);
      const workerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

      this.trackActivity(workerId, member.name, "worker");

      let workerDir = session.workingDir;
      if (useWorktrees) {
        const wtId = `${session.id.slice(0, 8)}-${workerId}`;
        workerDir = await createWorktree(session.workingDir, wtId);
        workerWtIds.push(wtId);
      }

      await this.emitter.agentSpawn(session.id, workerId, leadId, member.name, "worker",
        resolveModel(member.model), teamConfig["team-name"], member.color ?? teamConfig["team-color"]);

      // Extract this worker's assignment from the lead brief, or give full brief
      const assignment = this.parseAssignment(leadResult.output, member.name);
      const workerPrompt = assignment
        ? `Your assignment from ${teamConfig.lead.name}:\n${assignment}\n\nOriginal task: ${task}`
        : `Brief from ${teamConfig.lead.name}:\n${leadResult.output}\n\nOriginal task: ${task}`;

      const workerOpts: DelegateOptions = {
        persona: workerPersona,
        systemPrompt: buildSystemPrompt(workerPersona),
        userPrompt: workerPrompt,
        model: resolveModel(member.model),
        thinking: "medium" as const,
        tools: workerPersona.tools,
        domain: workerPersona.domain,
        workingDir: workerDir,
        sessionDir: `data/sessions/${session.id}`,
        parentId: leadId,
        teamName: teamConfig["team-name"],
        teamColor: member.color ?? teamConfig["team-color"],
        onStreamEvent: (streamEvt) => {
          if (streamEvt.type === "tool_call") {
            this.trackToolCall(workerId, streamEvt.tool ?? "");
            this.emitter.toolCall(session.id, workerId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running");
          } else if (streamEvt.type === "cost") {
            this.emitter.costUpdate(session.id, workerId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
          }
        },
        sendMessage: (fn) => {
          this.messageSenders.set(`${session.id}:${workerId}`, fn);
        },
      };

      const result = await delegateWithHealing({
        adapter,
        opts: workerOpts,
        sessionId: session.id,
        agentRole: "worker",
        onEvent: async (_type, data) => {
          await this.emitter.selfHeal(session.id, workerId, data.failed_worker as string, data.heal_action as string);
        },
      });

      session.totalCost += result.costUsd;
      session.totalTokens += result.tokensUsed;
      await this.emitter.costUpdate(session.id, workerId, result.costUsd, result.tokensUsed, 0);
      this.checkBudget(session, workerId, result.costUsd);

      return result;
    });

    const workerResults = await Promise.all(workerPromises);

    // Merge & cleanup worktrees
    for (const wtId of workerWtIds) {
      const { merged, hadChanges } = await mergeWorktree(session.workingDir, wtId);
      if (hadChanges) {
        if (merged) {
          console.log(`[orchestrator] Merged worktree ${wtId} (had changes)`);
        } else {
          console.warn(`[orchestrator] WARN: Failed to merge worktree ${wtId} -- changes may be lost`);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    }

    const combinedOutput = workerResults.map((r) => `[${r.agentName}]:\n${r.output}`).join("\n\n---\n\n");
    const worstGrade = this.worstGrade(workerResults.map((r) => r.grade));
    const succeeded = workerResults.filter((r) => r.grade !== "FAILED").length;

    await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
      `${teamConfig["team-name"]} complete. ${succeeded}/${workerResults.length} workers finished. Grade: ${worstGrade ?? "pending"}. Cost: $${(leadResult.costUsd + workerResults.reduce((s, r) => s + r.costUsd, 0)).toFixed(3)}.`);

    return {
      agentId: leadId,
      agentName: teamConfig.lead.name,
      output: combinedOutput,
      grade: worstGrade,
      findings: workerResults.flatMap((r) => r.findings ?? []),
      costUsd: leadResult.costUsd + workerResults.reduce((s, r) => s + r.costUsd, 0),
      tokensUsed: leadResult.tokensUsed + workerResults.reduce((s, r) => s + r.tokensUsed, 0),
    };
  }

  private parseAssignment(leadOutput: string, workerName: string): string | null {
    const pattern = new RegExp(
      `### ASSIGNMENT:\\s*${workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=### ASSIGNMENT:|$)`, "i"
    );
    const match = leadOutput.match(pattern);
    if (!match?.[1]) return null;
    const assignment = match[1].trim();
    return assignment.startsWith("SKIP:") ? null : assignment;
  }

  private worstGrade(grades: (string | undefined)[]): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
    const order: Record<string, number> = { PERFECT: 0, VERIFIED: 1, PARTIAL: 2, FEEDBACK: 3, FAILED: 4 };
    let worst: string | undefined;
    for (const g of grades) {
      if (!g) continue;
      if (!worst || (order[g] ?? 0) > (order[worst] ?? 0)) worst = g;
    }
    return worst as ReturnType<typeof this.worstGrade>;
  }

  private async runParallelStep(
    session: SessionState, step: ChainStep, task: string,
    previousOutput: string, adapterName?: string
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
      return this.runTeamStep(teamSession, { ...step, team: t.team }, task, previousOutput, adapterName);
    });

    const results = await Promise.all(promises);

    for (const wtId of teamWtIds) {
      const { merged, hadChanges } = await mergeWorktree(session.workingDir, wtId);
      if (hadChanges) {
        if (merged) {
          console.log(`[orchestrator] Merged team worktree ${wtId} (had changes)`);
        } else {
          console.warn(`[orchestrator] WARN: Failed to merge team worktree ${wtId} -- changes may be lost`);
        }
      }
      await cleanupWorktree(session.workingDir, wtId);
    }

    return results;
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

    this.trackActivity(agentId, agentConfig.name, "worker");

    await this.emitter.agentSpawn(session.id, agentId, parentId, agentConfig.name, "worker",
      resolveModel(agentConfig.model), teamName, teamColor);

    const prompt = [
      `Task: ${task}`,
      previousOutput ? `\nContext:\n${previousOutput}` : "",
    ].join("\n");

    const agentOpts: DelegateOptions = {
      persona,
      systemPrompt: buildSystemPrompt(persona),
      userPrompt: prompt,
      model: resolveModel(agentConfig.model),
      thinking: "medium" as const,
      tools: persona.tools,
      domain: persona.domain,
      workingDir: session.workingDir,
      sessionDir: `data/sessions/${session.id}`,
      parentId,
      teamName,
      teamColor,
      onStreamEvent: (streamEvt) => {
        if (streamEvt.type === "tool_call") {
          this.trackToolCall(agentId, streamEvt.tool ?? "");
          this.emitter.toolCall(session.id, agentId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running");
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
    this.checkBudget(session, agentId, result.costUsd);

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

  private budgets: {
    max_per_session_usd: number;
    warn_at_usd: number;
    max_per_agent_usd: number;
    max_total_tokens: number;
  } | null = null;
  private budgetWarned = false;

  private loadBudgets(): void {
    try {
      this.budgets = loadModelRouting().budgets ?? null;
      if (this.budgets) {
        console.log(`[budget] Limits: $${this.budgets.max_per_session_usd}/session, $${this.budgets.max_per_agent_usd}/agent, ${(this.budgets.max_total_tokens / 1e6).toFixed(0)}M tokens`);
      }
    } catch { this.budgets = null; }
  }

  private checkBudget(session: SessionState, agentId: string, agentCost: number): void {
    if (!this.budgets) return;

    if (agentCost > this.budgets.max_per_agent_usd) {
      console.warn(`[budget] Agent ${agentId} exceeded per-agent limit: $${agentCost.toFixed(3)} > $${this.budgets.max_per_agent_usd}`);
    }

    if (!this.budgetWarned && session.totalCost >= this.budgets.warn_at_usd) {
      this.budgetWarned = true;
      console.warn(`[budget] WARNING: Session cost $${session.totalCost.toFixed(3)} passed warn threshold $${this.budgets.warn_at_usd}`);
      this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Budget warning: session cost $${session.totalCost.toFixed(2)} has passed the $${this.budgets.warn_at_usd} threshold.`);
    }

    if (session.totalCost >= this.budgets.max_per_session_usd) {
      throw new Error(`Budget exceeded: session cost $${session.totalCost.toFixed(3)} >= limit $${this.budgets.max_per_session_usd}`);
    }

    if (session.totalTokens >= this.budgets.max_total_tokens) {
      throw new Error(`Token budget exceeded: ${session.totalTokens} >= limit ${this.budgets.max_total_tokens}`);
    }
  }

  private getAdapter(name?: string): PlatformAdapter {
    const adapterName = name ?? this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) throw new Error(`No adapter: ${adapterName}. Available: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }
}
