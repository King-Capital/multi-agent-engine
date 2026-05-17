import { describe, test, expect } from "bun:test";
import {
  buildTeamResult,
  buildParallelTeamStep,
  buildFailedWorkerReviews,
  buildFailedTeamResults,
  accumulateWorkerCosts,
  delegateToLead,
  buildWorkerSystemPromptAppend,
} from "./team-execution";
import type {
  DelegateResult,
  WorkerReview,
  SessionState,
  TeamConfig,
  ChainStep,
  PlatformAdapter,
} from "./types";
import type {
  PreparedTeamStep,
  WorkerExecutionResult,
} from "./team-execution";
import type { EventEmitter } from "./event-emitter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  name: string,
  id: string,
  overrides: Partial<DelegateResult> = {},
): DelegateResult {
  return {
    agentId: id,
    agentName: name,
    output: `Output from ${name}`,
    grade: "VERIFIED",
    findings: [],
    costUsd: 0.01,
    tokensUsed: 100,
    ...overrides,
  };
}

function makeReview(
  name: string,
  id: string,
  grade: "PASS" | "NEEDS_WORK" = "PASS",
  extras: Partial<WorkerReview> = {},
): WorkerReview {
  return {
    workerId: id,
    workerName: name,
    grade,
    ...extras,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "test-session",
    name: "Test",
    chain: "review",
    task: "Do the thing",
    workingDir: "/tmp/test",
    status: "active",
    agents: new Map(),
    tillDone: [],
    events: [],
    totalCost: 0,
    totalTokens: 0,
    startedAt: new Date(),
    ...overrides,
  };
}

function makeTeamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    "team-name": "TestTeam",
    "team-color": "#ff0000",
    "consult-when": "testing",
    lead: { name: "Lead", path: "agents/personas/lead.md", model: "opus", color: "#ff0000" },
    members: [
      { name: "Worker1", path: "agents/personas/w1.md", model: "sonnet", color: "#00ff00" },
      { name: "Worker2", path: "agents/personas/w2.md", model: "sonnet", color: "#0000ff" },
    ],
    ...overrides,
  };
}

function makeStep(overrides: Partial<ChainStep> = {}): ChainStep {
  return {
    team: "test-team",
    ...overrides,
  };
}

/** Stub emitter that records calls but doesn't hit the network */
function makeStubEmitter(): EventEmitter {
  const noop = async () => {};
  return {
    emit: noop,
    sessionStart: noop,
    agentSpawn: noop,
    agentDone: noop,
    message: noop,
    toolCall: noop,
    costUpdate: noop,
    tillDone: noop,
    domainBlock: noop,
    selfHeal: noop,
    stallDetected: noop,
    nudgeSent: noop,
    budgetWarning: noop,
    severityAlert: noop,
    sessionState: noop,
    autoPause: noop,
    sessionEnd: noop,
    pgCreateSession: noop,
    pgUpdateSession: noop,
    pgCreateAgent: noop,
    pgUpdateAgent: noop,
    trace: noop,
  } as unknown as EventEmitter;
}

function makeMockAdapter(
  overrides: Partial<{ delegate: PlatformAdapter["delegate"] }> = {},
): PlatformAdapter {
  return {
    name: "mock",
    isAvailable: async () => true,
    delegate: overrides.delegate ?? (async (opts) => makeResult(
      opts.persona.name,
      `mock-${opts.persona.name.toLowerCase().replace(/\s+/g, "-")}`,
    )),
  };
}

// ---------------------------------------------------------------------------
// buildParallelTeamStep
// ---------------------------------------------------------------------------

describe("buildWorkerSystemPromptAppend", () => {
  test("propagates worker safety constraints without lead-only final schema", () => {
    const append = [
      "REVIEW-ONLY MODE: inspect and report only. Do not edit files, apply patches, run fix scripts, or mutate worktrees unless the user explicitly asks for a fix phase.",
      "Use lightweight evidence commands only; if setup/dependencies are missing, report BLOCKERS instead of repairing the environment.",
      "Final response must include exactly one schema block starting with REVIEW_REPORT: Correctness, plus SCOPE, COMMANDS_RUN, FINDINGS with P0/P1/P2/P3 severity markers, BLOCKERS, and VERDICT.",
    ].join("\n");

    const result = buildWorkerSystemPromptAppend(append);

    expect(result).toContain("REVIEW-ONLY MODE");
    expect(result).toContain("Do not edit files");
    expect(result).toContain("Use lightweight evidence commands");
    expect(result).toContain("P0/P1/P2/P3");
    expect(result).not.toContain("Final response must include");
    expect(result).not.toContain("REVIEW_REPORT:");
  });
});

describe("buildParallelTeamStep", () => {
  test("preserves per-squad overrides for parallel swarm teams", () => {
    const step = makeStep({
      parallel: [
        {
          team: "Security Squad",
          tools_override: ["read", "grep"],
          system_prompt_append: "Act as the security SME lead.",
        },
      ],
      system_prompt_append: "Global swarm coordination rules.",
      till_done: ["Every squad reports evidence."],
      max_worker_retries: 2,
      read_only: true,
    });

    const built = buildParallelTeamStep(step, step.parallel![0]!);

    expect(built.team).toBe("Security Squad");
    expect(built.parallel).toBeUndefined();
    expect(built.read_only).toBe(true);
    expect(built.tools_override).toEqual(["read", "grep"]);
    expect(built.system_prompt_append).toContain("Global swarm coordination rules.");
    expect(built.system_prompt_append).toContain("Act as the security SME lead.");
    expect(built.till_done).toEqual(["Every squad reports evidence."]);
    expect(built.max_worker_retries).toBe(2);
  });

  test("inherits parent parallel settings when a squad does not override them", () => {
    const step = makeStep({
      parallel: [{ team: "Architecture Squad" }],
      tools_override: ["read"],
      system_prompt_append: "Parent instructions.",
    });

    const built = buildParallelTeamStep(step, step.parallel![0]!);

    expect(built.team).toBe("Architecture Squad");
    expect(built.tools_override).toEqual(["read"]);
    expect(built.system_prompt_append).toBe("Parent instructions.");
  });
});

// ---------------------------------------------------------------------------
// buildFailedWorkerReviews
// ---------------------------------------------------------------------------

describe("buildFailedWorkerReviews", () => {
  test("turns missing workers into retryable lead reviews", () => {
    const step = makeStep({ team: "Security Squad" });
    const teamConfig = makeTeamConfig({
      "team-name": "Security Squad",
      members: [
        { name: "Input Auditor", path: "agents/personas/reviewer.md", model: "sonnet", color: "#00ff00" },
      ],
    });
    const assignments = new Map([
      ["Security Squad-input-auditor", "Audit input handling in API routes."],
    ]);

    const reviews = buildFailedWorkerReviews(step, teamConfig, [
      { name: "Input Auditor", error: "timeout" },
    ], assignments);

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.workerId).toBe("Security Squad-input-auditor");
    expect(reviews[0]!.workerName).toBe("Input Auditor");
    expect(reviews[0]!.grade).toBe("NEEDS_WORK");
    expect(reviews[0]!.feedback).toContain("timeout");
    expect(reviews[0]!.reworkedPrompt).toContain("Audit input handling in API routes.");
  });
});

describe("buildFailedTeamResults", () => {
  test("preserves failed parallel squads as failed delegate results", () => {
    const results = buildFailedTeamResults([
      { name: "Security Squad", error: "lead crashed" },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.agentName).toBe("Security Squad");
    expect(results[0]!.agentId).toBe("security-squad-lead");
    expect(results[0]!.grade).toBe("FAILED");
    expect(results[0]!.findings).toEqual(["Security Squad: lead crashed"]);
  });
});

// ---------------------------------------------------------------------------
// buildTeamResult
// ---------------------------------------------------------------------------

describe("buildTeamResult", () => {
  test("combines outputs into a single DelegateResult", () => {
    const lead = makeResult("Lead", "team-lead", { costUsd: 0.05, tokensUsed: 500 });
    const workers = [
      makeResult("Worker1", "w1", { output: "Analysis A", costUsd: 0.02, tokensUsed: 200 }),
      makeResult("Worker2", "w2", { output: "Analysis B", costUsd: 0.03, tokensUsed: 300 }),
    ];
    const reviews = [
      makeReview("Worker1", "w1", "PASS"),
      makeReview("Worker2", "w2", "PASS"),
    ];

    const result = buildTeamResult(lead, "team-lead", "Lead", workers, reviews);

    expect(result.output).toContain("[Worker1]:");
    expect(result.output).toContain("Analysis A");
    expect(result.output).toContain("[Worker2]:");
    expect(result.output).toContain("Analysis B");
    expect(result.costUsd).toBe(0.05 + 0.02 + 0.03); // lead + workers
    expect(result.tokensUsed).toBe(500 + 200 + 300);
    expect(result.agentId).toBe("team-lead");
    expect(result.agentName).toBe("Lead");
  });

  test("uses VERIFIED grade when all reviews pass", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [makeResult("W1", "w1")];
    const reviews = [makeReview("W1", "w1", "PASS")];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.grade).toBe("VERIFIED");
  });

  test("uses FAILED grade when any review is not PASS", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [
      makeResult("W1", "w1"),
      makeResult("W2", "w2"),
    ];
    const reviews = [
      makeReview("W1", "w1", "PASS"),
      makeReview("W2", "w2", "NEEDS_WORK"),
    ];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.grade).toBe("FAILED");
  });

  test("includes review feedback in findings", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [makeResult("W1", "w1")];
    const reviews = [
      makeReview("W1", "w1", "NEEDS_WORK", { feedback: "Missing error handling" }),
    ];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.findings).toBeDefined();
    expect(result.findings!.some((f) => f.includes("Missing error handling"))).toBe(true);
  });

  test("includes quality notes from reviews", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [makeResult("W1", "w1")];
    const reviews = [
      makeReview("W1", "w1", "PASS", { qualityNotes: ["Could use better naming"] }),
    ];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.qualityNotes).toEqual(["Could use better naming"]);
  });

  test("includes worker findings in combined result", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [
      makeResult("W1", "w1", { findings: ["P0: SQL injection in auth.ts"] }),
      makeResult("W2", "w2", { findings: ["P1: Missing rate limiting"] }),
    ];
    const reviews = [
      makeReview("W1", "w1", "PASS"),
      makeReview("W2", "w2", "PASS"),
    ];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.findings).toContain("P0: SQL injection in auth.ts");
    expect(result.findings).toContain("P1: Missing rate limiting");
  });

  test("attaches reviews array to result", () => {
    const lead = makeResult("Lead", "lead");
    const workers = [makeResult("W1", "w1")];
    const reviews = [makeReview("W1", "w1", "PASS")];

    const result = buildTeamResult(lead, "lead", "Lead", workers, reviews);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews![0]!.workerName).toBe("W1");
  });

  test("handles empty workers list", () => {
    const lead = makeResult("Lead", "lead", { costUsd: 0.05, tokensUsed: 500 });
    const result = buildTeamResult(lead, "lead", "Lead", [], []);

    expect(result.output).toBe("");
    expect(result.costUsd).toBe(0.05);
    expect(result.tokensUsed).toBe(500);
    expect(result.grade).toBe("VERIFIED"); // all (zero) reviews pass
  });
});

// ---------------------------------------------------------------------------
// accumulateWorkerCosts
// ---------------------------------------------------------------------------

describe("accumulateWorkerCosts", () => {
  test("sums costs from all worker results to session totals", async () => {
    const session = makeSession({ totalCost: 0.10, totalTokens: 1000 });
    const workers = [
      makeResult("W1", "w1", { costUsd: 0.02, tokensUsed: 200 }),
      makeResult("W2", "w2", { costUsd: 0.03, tokensUsed: 300 }),
    ];
    const execution: WorkerExecutionResult = {
      workerResults: workers,
      failedWorkers: [],
      workerAssignments: new Map(),
      workerWtIds: [],
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
    };

    await accumulateWorkerCosts(deps, session, makeStep(), makeTeamConfig(), execution);

    expect(session.totalCost).toBe(0.10 + 0.02 + 0.03);
    expect(session.totalTokens).toBe(1000 + 200 + 300);
  });

  test("generates failure notice when workers failed", async () => {
    const session = makeSession();
    const execution: WorkerExecutionResult = {
      workerResults: [makeResult("W1", "w1")],
      failedWorkers: [{ name: "W2", error: "timeout" }],
      workerAssignments: new Map(),
      workerWtIds: [],
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
    };

    const result = await accumulateWorkerCosts(deps, session, makeStep(), makeTeamConfig(), execution);

    expect(result.failureNotice).toContain("WARNING");
    expect(result.failureNotice).toContain("W2");
    expect(result.failureNotice).toContain("timeout");
    expect(result.failureNotice).toContain("1 of 2"); // 1 result of 2 members
  });

  test("returns empty notice when all workers succeeded", async () => {
    const session = makeSession();
    const execution: WorkerExecutionResult = {
      workerResults: [makeResult("W1", "w1"), makeResult("W2", "w2")],
      failedWorkers: [],
      workerAssignments: new Map(),
      workerWtIds: [],
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
    };

    const result = await accumulateWorkerCosts(deps, session, makeStep(), makeTeamConfig(), execution);

    expect(result.failureNotice).toBe("");
  });

  test("calls checkBudget for each worker before accumulating cost", async () => {
    const budgetChecks: { agentId: string; cost: number }[] = [];
    const session = makeSession({ totalCost: 0 });
    const execution: WorkerExecutionResult = {
      workerResults: [
        makeResult("W1", "w1", { costUsd: 0.05 }),
        makeResult("W2", "w2", { costUsd: 0.10 }),
      ],
      failedWorkers: [],
      workerAssignments: new Map(),
      workerWtIds: [],
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: (_s: SessionState, agentId: string, cost: number) => {
        budgetChecks.push({ agentId, cost });
      },
    };

    await accumulateWorkerCosts(deps, session, makeStep(), makeTeamConfig(), execution);

    expect(budgetChecks).toHaveLength(2);
    expect(budgetChecks[0]!.agentId).toBe("w1");
    expect(budgetChecks[0]!.cost).toBe(0.05);
    expect(budgetChecks[1]!.agentId).toBe("w2");
    expect(budgetChecks[1]!.cost).toBe(0.10);
  });

  test("emits worker_failed events for each failed worker", async () => {
    const emittedEvents: unknown[] = [];
    const session = makeSession();
    const execution: WorkerExecutionResult = {
      workerResults: [],
      failedWorkers: [
        { name: "W1", error: "crash" },
        { name: "W2", error: "timeout" },
      ],
      workerAssignments: new Map(),
      workerWtIds: [],
    };

    const stubEmitter = makeStubEmitter();
    stubEmitter.emit = (async (event: unknown) => {
      emittedEvents.push(event);
    }) as typeof stubEmitter.emit;

    const deps = {
      emitter: stubEmitter,
      checkBudget: () => {},
    };

    await accumulateWorkerCosts(deps, session, makeStep(), makeTeamConfig(), execution);

    const failedEvents = emittedEvents.filter(
      (e: unknown) => (e as { event_type: string }).event_type === "worker_failed",
    );
    expect(failedEvents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// delegateToLead
// ---------------------------------------------------------------------------

describe("delegateToLead", () => {
  test("returns lead output and cost from adapter", async () => {
    const session = makeSession();
    const adapter = makeMockAdapter({
      delegate: async () => makeResult("Lead", "lead", {
        output: "Team briefing here",
        costUsd: 0.08,
        tokensUsed: 800,
        grade: "VERIFIED",
      }),
    });

    const prepared: PreparedTeamStep = {
      teamConfig: makeTeamConfig(),
      leadPersona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
      leadId: "test-lead",
      leadOpts: {
        persona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
        systemPrompt: "You are a lead",
        userPrompt: "Do the thing",
        model: "opus",
        thinking: "medium" as const,
        tools: ["read"],
        domain: { read: ["**/*"], write: [], update: [] },
        workingDir: "/tmp",
        sessionDir: "data/sessions/test",
        teamName: "TestTeam",
        teamColor: "#ff0000",
      },
      leadResolved: { model: "opus", thinking: "medium" as const },
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
      untrackActivity: () => {},
    };

    const result = await delegateToLead(deps, session, prepared, adapter);

    expect(result.leadResult.output).toBe("Team briefing here");
    expect(result.leadCost).toBe(0.08);
    expect(result.leadTokens).toBe(800);
    expect(result.earlyReturn).toBeUndefined();
    // Costs should be accumulated on the session
    expect(session.totalCost).toBe(0.08);
    expect(session.totalTokens).toBe(800);
  });

  test("returns earlyReturn when lead grade is FAILED", async () => {
    const session = makeSession();
    const adapter = makeMockAdapter({
      delegate: async () => makeResult("Lead", "lead", { grade: "FAILED" }),
    });

    const prepared: PreparedTeamStep = {
      teamConfig: makeTeamConfig(),
      leadPersona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
      leadId: "test-lead",
      leadOpts: {
        persona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
        systemPrompt: "You are a lead",
        userPrompt: "Do the thing",
        model: "opus",
        thinking: "medium" as const,
        tools: ["read"],
        domain: { read: ["**/*"], write: [], update: [] },
        workingDir: "/tmp",
        sessionDir: "data/sessions/test",
        teamName: "TestTeam",
        teamColor: "#ff0000",
      },
      leadResolved: { model: "opus", thinking: "medium" as const },
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
      untrackActivity: () => {},
    };

    const result = await delegateToLead(deps, session, prepared, adapter);

    expect(result.earlyReturn).toBeDefined();
    expect(result.earlyReturn!.grade).toBe("FAILED");
  });

  test("returns earlyReturn when team has no members", async () => {
    const session = makeSession();
    const adapter = makeMockAdapter({
      delegate: async () => makeResult("Lead", "lead", { grade: "VERIFIED" }),
    });

    const teamConfig = makeTeamConfig({ members: [] });

    const prepared: PreparedTeamStep = {
      teamConfig,
      leadPersona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
      leadId: "test-lead",
      leadOpts: {
        persona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
        systemPrompt: "You are a lead",
        userPrompt: "Do the thing",
        model: "opus",
        thinking: "medium" as const,
        tools: ["read"],
        domain: { read: ["**/*"], write: [], update: [] },
        workingDir: "/tmp",
        sessionDir: "data/sessions/test",
        teamName: "TestTeam",
        teamColor: "#ff0000",
      },
      leadResolved: { model: "opus", thinking: "medium" as const },
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
      untrackActivity: () => {},
    };

    const result = await delegateToLead(deps, session, prepared, adapter);

    expect(result.earlyReturn).toBeDefined();
  });

  test("accumulates cost and tokens on session", async () => {
    const session = makeSession({ totalCost: 0.10, totalTokens: 500 });
    const adapter = makeMockAdapter({
      delegate: async () => makeResult("Lead", "lead", { costUsd: 0.05, tokensUsed: 300 }),
    });

    const prepared: PreparedTeamStep = {
      teamConfig: makeTeamConfig(),
      leadPersona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
      leadId: "test-lead",
      leadOpts: {
        persona: { name: "Lead", model: "opus", expertise: "", skills: [], tools: ["read"], domain: { read: ["**/*"], write: [], update: [] } },
        systemPrompt: "test",
        userPrompt: "test",
        model: "opus",
        thinking: "medium" as const,
        tools: ["read"],
        domain: { read: ["**/*"], write: [], update: [] },
        workingDir: "/tmp",
        sessionDir: "data/sessions/test",
        teamName: "TestTeam",
        teamColor: "#ff0000",
      },
      leadResolved: { model: "opus", thinking: "medium" as const },
    };

    const deps = {
      emitter: makeStubEmitter(),
      checkBudget: () => {},
      untrackActivity: () => {},
    };

    await delegateToLead(deps, session, prepared, adapter);

    expect(session.totalCost).toBeCloseTo(0.15, 10);
    expect(session.totalTokens).toBe(800);
  });
});
