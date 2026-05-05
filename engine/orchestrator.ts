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
import {
  registerPersonaHash,
  sanitizeAgentInput,
  validateAgentOutput,
} from "./security";
import { delegateWithHealing } from "./self-healing";
import type {
  PlatformAdapter,
  DelegateResult,
  DelegateOptions,
  Chain,
  ChainStep,
  TeamConfig,
  SessionState,
  TillDoneItem,
} from "./types";

export class Orchestrator {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private defaultAdapter: string = "";
  private emitter: EventEmitter;
  private sessions: Map<string, SessionState> = new Map();

  constructor(dashboardUrl?: string) {
    this.emitter = new EventEmitter(dashboardUrl);
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

  async run(opts: {
    prompt?: string;
    chain?: string;
    task: string;
    args?: string[];
    adapter?: string;
    sessionName?: string;
    workingDir?: string;
  }): Promise<SessionState> {
    const sessionId = randomUUID().slice(0, 8);
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

    // Persist session to PG
    await this.emitter.pgCreateSession({
      id: sessionId,
      name: sessionName,
      chain: chainName,
      team: chainName,
    });

    const teams = loadTeams();
    const orchPersona = loadPersona(teams.orchestrator.path);
    await this.emitter.agentSpawn(
      sessionId,
      "orch-1",
      "",
      orchPersona.name,
      "orchestrator",
      resolveModel(teams.orchestrator.model),
      "Orchestration",
      teams.orchestrator.color ?? "#36f9f6"
    );

    // Persist orchestrator agent to PG
    await this.emitter.pgCreateAgent({
      sessionId,
      agentId: "orch-1",
      role: "orchestrator",
      persona: orchPersona.name,
    });

    console.log(`\n[orchestrator] Session: ${sessionName}`);
    console.log(`[orchestrator] Chain: ${chainName}`);
    console.log(`[orchestrator] Dashboard: http://localhost:8400/session/${sessionId}`);
    console.log(`[orchestrator] Task: ${opts.task}\n`);

    await this.emitter.tillDone(sessionId, sessionName, session.tillDone);

    try {
      await this.runChain(session, chain, taskBody, opts.adapter);
      session.status = "completed";
    } catch (err) {
      session.status = "error";
      console.error(`[orchestrator] Session failed:`, err);
      // Update PG session status on error
      await this.emitter.pgUpdateSession(sessionId, { status: "failed" });
    }

    await this.emitter.sessionEnd(sessionId);
    return session;
  }

  private async runChain(
    session: SessionState,
    chain: Chain,
    task: string,
    adapterName?: string
  ): Promise<void> {
    // Normalize: chains with top-level `parallel`/`then` (e.g. parallel-build)
    // get converted to a steps array so the main loop handles both formats.
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    let previousOutput = "";

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;

      const stepLabel = step.team ?? step.agent ?? "parallel teams";
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user",
        `Starting step ${i + 1}/${steps.length}: handing off to ${stepLabel}.`);

      if (step.parallel) {
        const results = await this.runParallelStep(session, step, task, previousOutput, adapterName);
        previousOutput = results.map((r) => `[${r.agentName}]: ${r.output}`).join("\n\n");
      } else if (step.team) {
        const result = await this.runTeamStep(session, step, task, previousOutput, adapterName);
        previousOutput = result.output;

        if (step.on_feedback && result.grade && ["FEEDBACK", "FAILED"].includes(result.grade)) {
          previousOutput = await this.runFeedbackLoop(
            session,
            step,
            task,
            result,
            adapterName
          );
        }
      } else if (step.agent) {
        const result = await this.runAgentStep(session, step, task, previousOutput, adapterName);
        previousOutput = result.output;
      }

      this.markTillDone(session, i);
      await this.emitter.tillDone(session.id, session.name, session.tillDone);
    }
  }

  /**
   * Converts a chain with top-level `parallel`/`then` keys into a steps array.
   * Example: parallel-build has `parallel: [{team: A}, {team: B}]` and `then: [{team: Validation}]`
   * This becomes: [{ parallel: [...] }, ...thenSteps]
   */
  private normalizeParallelChain(chain: Chain): ChainStep[] {
    const steps: ChainStep[] = [];
    if (chain.parallel) {
      steps.push({ parallel: chain.parallel });
    }
    if (chain.then) {
      steps.push(...chain.then);
    }
    return steps;
  }

  private async runTeamStep(
    session: SessionState,
    step: ChainStep,
    task: string,
    previousOutput: string,
    adapterName?: string
  ): Promise<DelegateResult> {
    const teamConfig = getTeam(step.team!);
    const adapter = this.getAdapter(adapterName);

    console.log(`[orchestrator] Delegating to team: ${teamConfig["team-name"]}`);

    const leadPersona = loadPersona(teamConfig.lead.path);
    const leadPrompt = this.buildLeadPrompt(teamConfig, task, previousOutput, step.till_done);

    const leadId = `${step.team}-lead`;

    await this.emitter.agentSpawn(
      session.id,
      leadId,
      "orch-1",
      teamConfig.lead.name,
      "lead",
      resolveModel(teamConfig.lead.model),
      teamConfig["team-name"],
      teamConfig["team-color"]
    );

    // Persist lead agent to PG
    await this.emitter.pgCreateAgent({
      sessionId: session.id,
      agentId: leadId,
      role: "lead",
      persona: teamConfig.lead.name,
      prompt: leadPrompt.slice(0, 2000),
    });

    await this.emitter.message(
      session.id,
      "orch-1",
      "Orchestrator",
      teamConfig.lead.name,
      leadPrompt.slice(0, 500) + (leadPrompt.length > 500 ? "..." : "")
    );

    // Enforce: leads must not have write/edit tools (only delegate + read tools)
    leadPersona.tools = leadPersona.tools.filter(
      (t) => !["write", "edit", "delegate"].includes(t)
    );

    registerPersonaHash(teamConfig.lead.path);

    const sanitizedLeadPrompt = sanitizeAgentInput(leadPrompt);

    const leadOpts: DelegateOptions = {
      persona: leadPersona,
      systemPrompt: buildSystemPrompt(leadPersona),
      userPrompt: sanitizedLeadPrompt,
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
          this.emitter.toolCall(session.id, leadId, streamEvt.tool ?? "", streamEvt.filePath ?? "", streamEvt.status ?? "running");
        } else if (streamEvt.type === "cost") {
          this.emitter.costUpdate(session.id, leadId, streamEvt.costUsd ?? 0, streamEvt.tokensUsed ?? 0, streamEvt.cacheReadTokens ?? 0);
        }
      },
    };

    const leadResult = await delegateWithHealing({
      adapter,
      opts: leadOpts,
      sessionId: session.id,
      agentRole: "lead",
      onEvent: (type, data) => this.emitter.emit({
        session_id: session.id,
        agent_id: leadId,
        event_type: type,
        timestamp: new Date().toISOString(),
        data,
      }),
    });

    this.redactSensitiveOutput(leadResult, leadPersona.name);
    session.totalCost += leadResult.costUsd;
    session.totalTokens += leadResult.tokensUsed;

    await this.emitter.costUpdate(session.id, leadId, leadResult.costUsd, leadResult.tokensUsed, 0);

    // Update lead agent status in PG
    await this.emitter.pgUpdateAgent(leadId, {
      status: leadResult.grade === "FAILED" ? "failed" : "completed",
      cost_usd: leadResult.costUsd,
      result: { output: leadResult.output.slice(0, 5000), grade: leadResult.grade },
    });

    // If lead failed or team has no workers, return lead result directly
    if (!teamConfig.members.length || leadResult.grade === "FAILED") {
      const statusMsg = leadResult.grade === "FAILED"
        ? `${teamConfig["team-name"]} lead could not complete the task.`
        : `${teamConfig["team-name"]} completed. ${this.summarizeOutput(leadResult.output)}`;
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user", statusMsg);
      return leadResult;
    }

    // Flat delegation: spawn workers with targeted assignments (or full brief for single worker)
    const hasMultipleWorkers = teamConfig.members.length > 1;
    let activeMembers = hasMultipleWorkers
      ? teamConfig.members.filter((m) => this.parseWorkerAssignment(leadResult.output, m.name) !== null)
      : [...teamConfig.members];

    if (activeMembers.length === 0) {
      console.log(`[orchestrator] Lead produced no worker assignments. Using full brief for first worker.`);
      activeMembers = [teamConfig.members[0]!];
    }

    console.log(`[orchestrator] Lead briefed. Spawning ${activeMembers.length} worker(s): ${activeMembers.map((m) => m.name).join(", ")}`);

    const spawnMsg = activeMembers.length === 1
      ? `${teamConfig["team-name"]} lead assigned ${activeMembers[0]!.name} to handle the work.`
      : `${teamConfig["team-name"]} lead split the work across ${activeMembers.length} workers: ${activeMembers.map((m) => m.name).join(", ")}. Running in parallel.`;
    await this.emitter.message(session.id, "orch-1", "Orchestrator", "user", spawnMsg);

    const workerPromises = activeMembers.map(async (member) => {
      const workerPersona = loadPersona(member.path);
      const workerId = `${step.team}-${member.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

      await this.emitter.agentSpawn(
        session.id,
        workerId,
        leadId,
        member.name,
        "worker",
        resolveModel(member.model),
        teamConfig["team-name"],
        member.color ?? teamConfig["team-color"]
      );

      // Persist worker agent to PG
      await this.emitter.pgCreateAgent({
        sessionId: session.id,
        agentId: workerId,
        role: "worker",
        persona: member.name,
      });

      const assignment = hasMultipleWorkers
        ? this.parseWorkerAssignment(leadResult.output, member.name)
        : null;

      const workerPrompt = assignment
        ? [
            `Your assignment from ${teamConfig.lead.name}:`,
            assignment,
            "",
            `Original task context: ${task}`,
            previousOutput ? `\nPrevious step context:\n${previousOutput}` : "",
          ].join("\n")
        : [
            `Brief from ${teamConfig.lead.name}:`,
            leadResult.output,
            "",
            `Original task: ${task}`,
            previousOutput ? `\nPrevious step context:\n${previousOutput}` : "",
            step.till_done ? `\nTill done:\n${step.till_done.map((t) => `- [ ] ${t}`).join("\n")}` : "",
          ].join("\n");

      const workerOpts: DelegateOptions = {
        persona: workerPersona,
        systemPrompt: buildSystemPrompt(workerPersona),
        userPrompt: sanitizeAgentInput(workerPrompt),
        model: resolveModel(member.model),
        thinking: "medium" as const,
        tools: workerPersona.tools,
        domain: workerPersona.domain,
        workingDir: session.workingDir,
        sessionDir: `data/sessions/${session.id}`,
        parentId: leadId,
        teamName: teamConfig["team-name"],
        teamColor: member.color ?? teamConfig["team-color"],
      };

      const workerResult = await delegateWithHealing({
        adapter,
        opts: workerOpts,
        sessionId: session.id,
        agentRole: "worker",
        onEvent: (type, data) => this.emitter.emit({
          session_id: session.id,
          agent_id: workerId,
          event_type: type,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      this.redactSensitiveOutput(workerResult, member.name);
      session.totalCost += workerResult.costUsd;
      session.totalTokens += workerResult.tokensUsed;

      await this.emitter.costUpdate(session.id, workerId, workerResult.costUsd, workerResult.tokensUsed, 0);

      // Update worker agent status in PG
      await this.emitter.pgUpdateAgent(workerId, {
        status: workerResult.grade === "FAILED" ? "failed" : "completed",
        cost_usd: workerResult.costUsd,
        result: { output: workerResult.output.slice(0, 5000), grade: workerResult.grade },
      });

      const workerStatusMsg = workerResult.grade === "FAILED"
        ? `${member.name} ran into issues and could not complete their assignment.`
        : `${member.name} finished. ${this.summarizeOutput(workerResult.output)}`;
      await this.emitter.message(session.id, "orch-1", "Orchestrator", "user", workerStatusMsg);

      return workerResult;
    });

    const workerResults = await Promise.all(workerPromises);

    const budgets = this.loadBudgets();
    if (budgets && session.totalCost > budgets.max_per_session_usd) {
      console.error(`[orchestrator] Budget exceeded: $${session.totalCost.toFixed(2)} > $${budgets.max_per_session_usd}`);
      throw new Error(`Session budget exceeded: $${session.totalCost.toFixed(2)}`);
    }

    // Combine worker results (raw for internal chain, clean for dashboard)
    const combinedOutput = workerResults.map((r) => `[${r.agentName}]:\n${r.output}`).join("\n\n---\n\n");
    const combinedFindings = workerResults.flatMap((r) => r.findings ?? []);
    const worstGrade = this.worstGrade(workerResults.map((r) => r.grade));

    const succeeded = workerResults.filter((r) => r.grade !== "FAILED").length;
    const teamDoneMsg = `${teamConfig["team-name"]} complete. ${succeeded}/${workerResults.length} workers succeeded. Overall grade: ${worstGrade ?? "pending"}.`;
    await this.emitter.message(session.id, "orch-1", "Orchestrator", "user", teamDoneMsg);

    return {
      agentId: leadId,
      agentName: teamConfig.lead.name,
      output: combinedOutput,
      grade: worstGrade,
      findings: combinedFindings,
      costUsd: workerResults.reduce((sum, r) => sum + r.costUsd, 0) + leadResult.costUsd,
      tokensUsed: workerResults.reduce((sum, r) => sum + r.tokensUsed, 0) + leadResult.tokensUsed,
    };
  }

  private summarizeOutput(output: string): string {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    const files: string[] = [];
    const actions: string[] = [];
    let grade = "";

    for (const line of lines) {
      const fileMatch = line.match(/(?:FILE|Modified|Created|Edited|Fixed|Updated)[:\s]+[`']?([^\s`',]+)/i);
      if (fileMatch?.[1]) files.push(fileMatch[1]);

      const gradeMatch = line.match(/GRADE:\s*(PERFECT|VERIFIED|PARTIAL|FEEDBACK|FAILED)/i);
      if (gradeMatch?.[1]) grade = gradeMatch[1];

      if (/^[-*]\s+(?:Fixed|Added|Removed|Updated|Created|Changed)/i.test(line)) {
        actions.push(line.replace(/^[-*]\s+/, ""));
      }
    }

    const parts: string[] = [];
    if (files.length > 0) parts.push(`Touched ${files.length} file(s): ${files.slice(0, 4).join(", ")}${files.length > 4 ? ` +${files.length - 4} more` : ""}.`);
    if (actions.length > 0) parts.push(actions.slice(0, 3).join(". ") + ".");
    if (grade) parts.push(`Grade: ${grade}.`);

    if (parts.length === 0) {
      const firstSentence = output.replace(/[#*`|]/g, "").trim().split(/[.\n]/)[0] ?? "";
      return firstSentence.slice(0, 150) + (firstSentence.length > 150 ? "..." : ".");
    }

    return parts.join(" ");
  }

  private worstGrade(grades: (string | undefined)[]): "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED" | undefined {
    const order: Record<string, number> = { PERFECT: 0, VERIFIED: 1, PARTIAL: 2, FEEDBACK: 3, FAILED: 4 };
    let worst: string | undefined;
    for (const g of grades) {
      if (!g) continue;
      if (!worst || (order[g] ?? 0) > (order[worst] ?? 0)) worst = g;
    }
    return worst as any;
  }

  private async runParallelStep(
    session: SessionState,
    step: ChainStep,
    task: string,
    previousOutput: string,
    adapterName?: string
  ): Promise<DelegateResult[]> {
    const teams = step.parallel!;
    console.log(
      `[orchestrator] Running ${teams.length} teams in parallel: ${teams.map((t) => t.team).join(", ")}`
    );

    const promises = teams.map((t) =>
      this.runTeamStep(session, { ...step, team: t.team }, task, previousOutput, adapterName)
    );

    return Promise.all(promises);
  }

  private async runAgentStep(
    session: SessionState,
    step: ChainStep,
    task: string,
    previousOutput: string,
    adapterName?: string
  ): Promise<DelegateResult> {
    const teams = loadTeams();
    let agentConfig: { name: string; path: string; model: string } | undefined;
    let teamName = "Solo";
    let teamColor = "#94a3b8";

    for (const team of teams.teams) {
      const member = team.members.find(
        (m) => m.name.toLowerCase() === step.agent?.toLowerCase()
      );
      if (member) {
        agentConfig = member;
        teamName = team["team-name"];
        teamColor = team["team-color"];
        break;
      }
    }

    if (!agentConfig) {
      throw new Error(`Agent not found: ${step.agent}`);
    }

    const persona = loadPersona(agentConfig.path);
    const adapter = this.getAdapter(adapterName);

    const prompt = [
      `Task: ${task}`,
      previousOutput ? `\nPrevious output:\n${previousOutput}` : "",
      step.till_done ? `\nTill done:\n${step.till_done.map((t) => `- [ ] ${t}`).join("\n")}` : "",
    ].join("\n");

    await this.emitter.agentSpawn(
      session.id,
      step.agent!,
      "orch-1",
      agentConfig.name,
      "worker",
      resolveModel(agentConfig.model),
      teamName,
      teamColor
    );

    // Persist solo agent to PG
    await this.emitter.pgCreateAgent({
      sessionId: session.id,
      agentId: step.agent!,
      role: "worker",
      persona: agentConfig.name,
      prompt: prompt.slice(0, 2000),
    });

    const sanitizedPrompt = sanitizeAgentInput(prompt);

    const isScout = step.agent?.toLowerCase() === "scout";
    const delegateOpts = {
      persona,
      systemPrompt: buildSystemPrompt(persona),
      userPrompt: sanitizedPrompt,
      model: resolveModel(agentConfig.model),
      thinking: (isScout ? "low" : "medium") as "low" | "medium",
      tools: persona.tools,
      domain: persona.domain,
      workingDir: session.workingDir,
      sessionDir: `data/sessions/${session.id}`,
      parentId: "orch-1",
      teamName,
      teamColor,
    };

    const result = await delegateWithHealing({
      adapter,
      opts: delegateOpts,
      sessionId: session.id,
      agentRole: isScout ? "scout" : "worker",
      onEvent: (type, data) => this.emitter.emit({
        session_id: session.id,
        agent_id: step.agent!,
        event_type: type,
        timestamp: new Date().toISOString(),
        data,
      }),
    });

    this.redactSensitiveOutput(result, agentConfig.name);

    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;

    // Update solo agent status in PG
    await this.emitter.pgUpdateAgent(step.agent!, {
      status: result.grade === "FAILED" ? "failed" : "completed",
      cost_usd: result.costUsd,
      result: { output: result.output.slice(0, 5000), grade: result.grade },
    });

    const budgets = this.loadBudgets();
    if (budgets && session.totalCost > budgets.max_per_session_usd) {
      console.error(`[orchestrator] Budget exceeded: $${session.totalCost.toFixed(2)} > $${budgets.max_per_session_usd}`);
      throw new Error(`Session budget exceeded: $${session.totalCost.toFixed(2)}`);
    }

    return result;
  }

  private async runFeedbackLoop(
    session: SessionState,
    step: ChainStep,
    task: string,
    initialResult: DelegateResult,
    adapterName?: string
  ): Promise<string> {
    const fb = step.on_feedback!;
    let lastResult = initialResult;
    let attempt = 1;

    while (attempt < fb.max_attempts) {
      attempt++;
      console.log(
        `[orchestrator] Feedback loop: attempt ${attempt}/${fb.max_attempts} via ${fb.retry_team}`
      );

      const corrections = lastResult.findings?.join("\n") ?? lastResult.output;
      const retryResult = await this.runTeamStep(
        session,
        { team: fb.retry_team },
        `${task}\n\nCorrections from validation (attempt ${attempt}):\n${corrections}`,
        lastResult.output,
        adapterName
      );

      const revalResult = await this.runTeamStep(
        session,
        { team: step.team! },
        task,
        retryResult.output,
        adapterName
      );

      if (revalResult.grade && ["PERFECT", "VERIFIED"].includes(revalResult.grade)) {
        return revalResult.output;
      }

      lastResult = revalResult;
    }

    console.log(`[orchestrator] Max attempts reached. Escalating to ${fb.escalate_to}.`);
    return `ESCALATED: After ${fb.max_attempts} attempts, the following issues remain:\n${lastResult.output}`;
  }

  private buildLeadPrompt(
    team: TeamConfig,
    task: string,
    previousOutput: string,
    tillDone?: string[]
  ): string {
    const members = team.members
      .map((m) => `- ${m.name} (${m.model}): ${m["consult-when"] ?? "general tasks"}`)
      .join("\n");

    const hasMultipleWorkers = team.members.length > 1;

    const delegationInstructions = hasMultipleWorkers
      ? [
          `You have ${team.members.length} workers. Split the task into independent assignments.`,
          `Each worker runs IN PARALLEL on the same repo -- assignments MUST NOT touch the same files.`,
          "",
          `Output your plan using this exact format for each worker:`,
          "",
          ...team.members.map((m) => [
            `### ASSIGNMENT: ${m.name}`,
            `[Specific instructions for this worker. Which files to modify, what to change, what to verify.]`,
            "",
          ].join("\n")),
          `If the task is too small to split, assign everything to ${team.members[0]!.name} and give the others "SKIP: No work needed."`,
        ].join("\n")
      : `Delegate to your worker as needed. Report back when complete.`;

    return [
      `@${team.lead.name}:`,
      "",
      `Task: ${task}`,
      "",
      previousOutput ? `Previous step output:\n${previousOutput}\n` : "",
      `Your team members:`,
      members,
      "",
      tillDone ? `Till done:\n${tillDone.map((t) => `- [ ] ${t}`).join("\n")}` : "",
      "",
      delegationInstructions,
    ].join("\n");
  }

  private parseWorkerAssignment(leadOutput: string, workerName: string): string | null {
    const pattern = new RegExp(
      `### ASSIGNMENT:\\s*${workerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=### ASSIGNMENT:|$)`,
      "i"
    );
    const match = leadOutput.match(pattern);
    if (!match?.[1]) return null;
    const assignment = match[1].trim();
    if (assignment.startsWith("SKIP:")) return null;
    return assignment;
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

  private markTillDone(session: SessionState, stepIndex: number): void {
    let idx = 0;
    const chain = getChain(session.chain);
    const steps = chain.steps ?? this.normalizeParallelChain(chain);
    for (let i = 0; i <= stepIndex && i < steps.length; i++) {
      const step = steps[i]!;
      const count = step.till_done?.length ?? 1;
      for (let j = 0; j < count; j++) {
        if (idx < session.tillDone.length) {
          session.tillDone[idx]!.completed = true;
          session.tillDone[idx]!.active = false;
          idx++;
        }
      }
    }
    if (idx < session.tillDone.length) {
      session.tillDone[idx]!.active = true;
    }
  }

  private interpolatePrompt(body: string, args: string[]): string {
    return body.replace(/\$(\d+)/g, (match, numStr) => {
      const idx = parseInt(numStr, 10) - 1;
      return idx >= 0 && idx < args.length ? args[idx]! : match;
    });
  }

  private redactSensitiveOutput(result: DelegateResult, agentName: string): void {
    const violations = validateAgentOutput(result.output);
    if (violations.length === 0) return;
    console.warn(`[orchestrator] WARNING: Output from ${agentName} contains sensitive data: ${violations.map((v) => v.reason).join(", ")}`);
    result.output = result.output
      .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi, "[REDACTED]")
      .replace(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, "[REDACTED]")
      .replace(/ghp_[A-Za-z0-9_]{36}/g, "[REDACTED]")
      .replace(/sk-[A-Za-z0-9]{48}/g, "[REDACTED]")
      .replace(/sk-ant-[A-Za-z0-9-]{95}/g, "[REDACTED]");
  }

  private loadBudgets(): { max_per_session_usd: number; warn_at_usd: number } | null {
    try {
      const config = loadModelRouting();
      return config.budgets ?? null;
    } catch { return null; }
  }

  private getAdapter(name?: string): PlatformAdapter {
    const adapterName = name ?? this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new Error(
        `No adapter: ${adapterName}. Available: ${[...this.adapters.keys()].join(", ")}`
      );
    }
    return adapter;
  }
}
