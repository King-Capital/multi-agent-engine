import { randomUUID } from "crypto";
import {
  loadTeams,
  loadPersona,
  buildSystemPrompt,
  resolveModel,
  getChain,
  getTeam,
  loadPrompt,
} from "./config";
import { EventEmitter } from "./event-emitter";
import {
  registerPersonaHash,
  verifyPersonaIntegrity,
  sanitizeAgentInput,
  validateAgentOutput,
} from "./security";
import type {
  PlatformAdapter,
  DelegateResult,
  Chain,
  ChainStep,
  TeamConfig,
  SessionState,
  TillDoneItem,
  ThinkingLevel,
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
    const sessionName = opts.sessionName ?? `${chainName}-${sessionId}`;

    const session: SessionState = {
      id: sessionId,
      name: sessionName,
      chain: chainName,
      task: taskBody,
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
    let previousOutput = "";

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i];

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

    await this.emitter.agentSpawn(
      session.id,
      `${step.team}-lead`,
      "orch-1",
      teamConfig.lead.name,
      "lead",
      resolveModel(teamConfig.lead.model),
      teamConfig["team-name"],
      teamConfig["team-color"]
    );

    await this.emitter.message(
      session.id,
      "orch-1",
      "Orchestrator",
      teamConfig.lead.name,
      leadPrompt.slice(0, 500) + (leadPrompt.length > 500 ? "..." : "")
    );

    // Enforce: leads must not have write/edit tools (only delegate + read tools)
    const hasWriteTools = leadPersona.tools.some((t) =>
      ["write", "edit"].includes(t)
    );
    if (hasWriteTools) {
      console.warn(
        `[orchestrator] WARNING: Lead ${leadPersona.name} has write/edit tools. ` +
        `Leads should delegate, not execute. Stripping write tools.`
      );
      leadPersona.tools = leadPersona.tools.filter(
        (t) => !["write", "edit"].includes(t)
      );
    }

    // Lock persona integrity -- detect tampering after load
    registerPersonaHash(teamConfig.lead.path);

    const sanitizedLeadPrompt = sanitizeAgentInput(leadPrompt);

    const result = await adapter.delegate({
      persona: leadPersona,
      systemPrompt: buildSystemPrompt(leadPersona),
      userPrompt: sanitizedLeadPrompt,
      model: resolveModel(teamConfig.lead.model),
      thinking: "high",
      tools: leadPersona.tools,
      domain: leadPersona.domain,
      sessionDir: `data/sessions/${session.id}`,
      parentId: "orch-1",
      teamName: teamConfig["team-name"],
      teamColor: teamConfig["team-color"],
    });

    const outputViolations = validateAgentOutput(result.output);
    if (outputViolations.length > 0) {
      console.warn(
        `[orchestrator] WARNING: Output from ${leadPersona.name} contains sensitive data: ` +
        outputViolations.map((v) => v.reason).join(", ")
      );
      for (const v of outputViolations) {
        result.output = result.output.replace(
          /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi,
          "[REDACTED]"
        );
        result.output = result.output.replace(
          /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
          "[REDACTED]"
        );
        result.output = result.output.replace(/ghp_[A-Za-z0-9_]{36}/g, "[REDACTED]");
        result.output = result.output.replace(/sk-[A-Za-z0-9]{48}/g, "[REDACTED]");
        result.output = result.output.replace(/sk-ant-[A-Za-z0-9-]{95}/g, "[REDACTED]");
      }
    }

    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;

    await this.emitter.costUpdate(
      session.id,
      `${step.team}-lead`,
      result.costUsd,
      result.tokensUsed,
      0
    );

    await this.emitter.message(
      session.id,
      `${step.team}-lead`,
      teamConfig.lead.name,
      "Orchestrator",
      result.output.slice(0, 500) + (result.output.length > 500 ? "..." : "")
    );

    return result;
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

    const sanitizedPrompt = sanitizeAgentInput(prompt);

    const isScout = step.agent?.toLowerCase() === "scout";
    const result = await adapter.delegate({
      persona,
      systemPrompt: buildSystemPrompt(persona),
      userPrompt: sanitizedPrompt,
      model: resolveModel(agentConfig.model),
      thinking: isScout ? "low" : "medium",
      tools: persona.tools,
      domain: persona.domain,
      sessionDir: `data/sessions/${session.id}`,
      parentId: "orch-1",
      teamName,
      teamColor,
    });

    const outputViolations = validateAgentOutput(result.output);
    if (outputViolations.length > 0) {
      console.warn(
        `[orchestrator] WARNING: Output from ${agentConfig.name} contains sensitive data: ` +
        outputViolations.map((v) => v.reason).join(", ")
      );
      for (const v of outputViolations) {
        result.output = result.output.replace(
          /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}/gi,
          "[REDACTED]"
        );
        result.output = result.output.replace(
          /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g,
          "[REDACTED]"
        );
        result.output = result.output.replace(/ghp_[A-Za-z0-9_]{36}/g, "[REDACTED]");
        result.output = result.output.replace(/sk-[A-Za-z0-9]{48}/g, "[REDACTED]");
        result.output = result.output.replace(/sk-ant-[A-Za-z0-9-]{95}/g, "[REDACTED]");
      }
    }

    session.totalCost += result.costUsd;
    session.totalTokens += result.tokensUsed;

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
      `Delegate to your workers as needed. Report back when complete.`,
    ].join("\n");
  }

  private buildTillDone(chain: Chain): TillDoneItem[] {
    const items: TillDoneItem[] = [];
    for (const step of chain.steps) {
      if (step.till_done) {
        for (const desc of step.till_done) {
          items.push({ description: desc, completed: false, active: false });
        }
      } else {
        const label = step.team ?? step.agent ?? "parallel step";
        items.push({ description: `${label} complete`, completed: false, active: false });
      }
    }
    if (items.length > 0) items[0].active = true;
    return items;
  }

  private markTillDone(session: SessionState, stepIndex: number): void {
    let idx = 0;
    const chain = getChain(session.chain);
    for (let i = 0; i <= stepIndex && i < chain.steps.length; i++) {
      const step = chain.steps[i];
      const count = step.till_done?.length ?? 1;
      for (let j = 0; j < count; j++) {
        if (idx < session.tillDone.length) {
          session.tillDone[idx].completed = true;
          session.tillDone[idx].active = false;
          idx++;
        }
      }
    }
    if (idx < session.tillDone.length) {
      session.tillDone[idx].active = true;
    }
  }

  private interpolatePrompt(body: string, args: string[]): string {
    let result = body;
    for (let i = 0; i < args.length; i++) {
      result = result.replaceAll(`$${i + 1}`, args[i]);
    }
    return result;
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
