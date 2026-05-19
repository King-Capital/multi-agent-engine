import { describe, test, expect } from "bun:test";
import { leadReviewWorkers, retryWorker } from "./worker-lifecycle";
import type {
  PlatformAdapter,
  DelegateOptions,
  DelegateResult,
  SessionState,
  TeamConfig,
  PersonaConfig,
  ChainStep,
} from "./types";
import type { WorkerLifecycleDeps } from "./worker-lifecycle";
import type { EventEmitter } from "./event-emitter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(name: string, id: string, overrides: Partial<DelegateResult> = {}): DelegateResult {
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

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "test-session",
    name: "Test",
    chain: "review",
    task: "Test task",
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

function makeTeamConfig(): TeamConfig {
  return {
    "team-name": "TestTeam",
    "team-color": "#ff0000",
    "consult-when": "testing",
    lead: { name: "Lead", path: "agents/personas/lead.md", model: "opus", color: "#ff0000" },
    members: [
      { name: "Worker1", path: "agents/personas/w1.md", model: "sonnet", color: "#00ff00" },
      { name: "Worker2", path: "agents/personas/w2.md", model: "sonnet", color: "#0000ff" },
    ],
  };
}

function makeRetryTeamConfig(): TeamConfig {
  return {
    ...makeTeamConfig(),
    members: [
      { name: "Backend Engineer", path: "agents/personas/backend-engineer.md", model: "sonnet", color: "#00ff00" },
    ],
  };
}

function makeLeadPersona(): PersonaConfig {
  return {
    name: "Lead",
    model: "opus",
    expertise: "agents/expertise/lead.md",
    skills: [],
    tools: ["read", "grep"],
    domain: { read: ["**/*"], write: ["**/*"], update: ["**/*"] },
    body: "You are a team lead.",
  };
}

function makeStep(overrides: Partial<ChainStep> = {}): ChainStep {
  return { team: "test-team", ...overrides };
}

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

function makeDeps(overrides: Partial<WorkerLifecycleDeps> = {}): WorkerLifecycleDeps {
  return {
    emitter: makeStubEmitter(),
    messageSenders: new Map(),
    trackToolCall: () => {},
    checkBudget: () => {},
    ...overrides,
  };
}

/**
 * Creates a mock adapter that returns a specific review output.
 * The lead review delegates to the adapter; the adapter output
 * is then parsed by parseReviews to produce WorkerReview[].
 */
function makeReviewAdapter(reviewOutput: string): PlatformAdapter {
  return {
    name: "mock-review",
    isAvailable: async () => true,
    delegate: async () => ({
      agentId: "lead-review",
      agentName: "Lead",
      output: reviewOutput,
      grade: "VERIFIED" as const,
      findings: [],
      costUsd: 0.02,
      tokensUsed: 200,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("leadReviewWorkers", () => {
  test("parses PASS reviews from adapter output", async () => {
    const workerResults = [
      makeResult("Worker1", "w1"),
      makeResult("Worker2", "w2"),
    ];

    const reviewOutput = [
      "### REVIEW: Worker1",
      "GRADE: PASS",
      "",
      "### REVIEW: Worker2",
      "GRADE: PASS",
    ].join("\n");

    const adapter = makeReviewAdapter(reviewOutput);
    const session = makeSession();
    const assignments = new Map<string, string>();

    const reviews = await leadReviewWorkers(
      makeDeps(), session, makeTeamConfig(), makeLeadPersona(),
      workerResults, assignments, "test task", adapter, makeStep(), "lead-1",
    );

    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.grade).toBe("PASS");
    expect(reviews[1]!.grade).toBe("PASS");
  });

  test("parses NEEDS_WORK review with feedback and reworked prompt", async () => {
    const workerResults = [makeResult("Worker1", "w1")];

    const reviewOutput = [
      "### REVIEW: Worker1",
      "GRADE: NEEDS_WORK",
      "FEEDBACK: Missing error handling in db module",
      "REWORKED_PROMPT: Add try-catch blocks around all DB calls",
    ].join("\n");

    const adapter = makeReviewAdapter(reviewOutput);
    const session = makeSession();

    const reviews = await leadReviewWorkers(
      makeDeps(), session, makeTeamConfig(), makeLeadPersona(),
      workerResults, new Map(), "test task", adapter, makeStep(), "lead-1",
    );

    expect(reviews[0]!.grade).toBe("NEEDS_WORK");
    expect(reviews[0]!.feedback).toBe("Missing error handling in db module");
    expect(reviews[0]!.reworkedPrompt).toBe("Add try-catch blocks around all DB calls");
  });

  test("accumulates review cost on session", async () => {
    const session = makeSession({ totalCost: 0.10, totalTokens: 500 });
    const adapter = makeReviewAdapter("### REVIEW: Worker1\nGRADE: PASS");

    await leadReviewWorkers(
      makeDeps(), session, makeTeamConfig(), makeLeadPersona(),
      [makeResult("Worker1", "w1")], new Map(), "task", adapter, makeStep(), "lead-1",
    );

    expect(session.totalCost).toBeCloseTo(0.12, 10); // 0.10 + 0.02 from adapter
    expect(session.totalTokens).toBe(700); // 500 + 200 from adapter
  });

  test("includes worker assignment context in review prompt", async () => {
    let capturedPrompt = "";
    const adapter: PlatformAdapter = {
      name: "capture",
      isAvailable: async () => true,
      delegate: async (opts) => {
        capturedPrompt = opts.userPrompt;
        return {
          agentId: "lead", agentName: "Lead",
          output: "### REVIEW: Worker1\nGRADE: PASS",
          grade: "VERIFIED" as const, findings: [],
          costUsd: 0.01, tokensUsed: 100,
        };
      },
    };

    const assignments = new Map([["w1", "Check the auth module for vulnerabilities"]]);

    await leadReviewWorkers(
      makeDeps(), makeSession(), makeTeamConfig(), makeLeadPersona(),
      [makeResult("Worker1", "w1")], assignments, "security review", adapter, makeStep(), "lead-1",
    );

    expect(capturedPrompt).toContain("Check the auth module for vulnerabilities");
    expect(capturedPrompt).toContain("security review");
    expect(capturedPrompt).toContain("Worker1");
  });

  test("defaults unmatched workers to PASS", async () => {
    const reviewOutput = "### REVIEW: SomeOtherWorker\nGRADE: NEEDS_WORK";
    const adapter = makeReviewAdapter(reviewOutput);

    const reviews = await leadReviewWorkers(
      makeDeps(), makeSession(), makeTeamConfig(), makeLeadPersona(),
      [makeResult("Worker1", "w1")], new Map(), "task", adapter, makeStep(), "lead-1",
    );

    // Worker1 not mentioned in review output → defaults to PASS
    expect(reviews[0]!.grade).toBe("PASS");
  });

  test("truncates long worker output in review prompt", async () => {
    let capturedPrompt = "";
    const adapter: PlatformAdapter = {
      name: "capture",
      isAvailable: async () => true,
      delegate: async (opts) => {
        capturedPrompt = opts.userPrompt;
        return {
          agentId: "lead", agentName: "Lead",
          output: "### REVIEW: Worker1\nGRADE: PASS",
          grade: "VERIFIED" as const, findings: [],
          costUsd: 0.01, tokensUsed: 100,
        };
      },
    };

    const longOutput = "x".repeat(5000);
    const workerResults = [makeResult("Worker1", "w1", { output: longOutput })];

    await leadReviewWorkers(
      makeDeps(), makeSession(), makeTeamConfig(), makeLeadPersona(),
      workerResults, new Map(), "task", adapter, makeStep(), "lead-1",
    );

    // Should truncate to ~3000 chars + truncation notice
    expect(capturedPrompt).toContain("...(truncated)");
    expect(capturedPrompt.length).toBeLessThan(longOutput.length);
  });
});

describe("retryWorker", () => {
  test("strict retry applies derived spawn decision constraints to delegate options", async () => {
    const previous = process.env.MAE_SPAWN_DECISION_STRICT;
    process.env.MAE_SPAWN_DECISION_STRICT = "1";
    let capturedTools: string[] = [];
    let capturedRead: string[] = [];
    try {
      const adapter: PlatformAdapter = {
        name: "capture",
        isAvailable: async () => true,
        delegate: async (opts) => {
          capturedTools = opts.tools;
          capturedRead = opts.domain.read;
          return makeResult("Backend Engineer", "retry", { output: "retry output" });
        },
      };
      const emitter = {
        ...makeStubEmitter(),
        spawnDecision: async () => {},
        agentSpawn: async () => {},
      } as unknown as EventEmitter;

      await retryWorker(
        makeDeps({ emitter }),
        makeSession({ workingDir: process.cwd() }),
        makeRetryTeamConfig(),
        makeRetryTeamConfig().members[0]!,
        "Redo the backend pass",
        "Review backend",
        adapter,
        "lead-1",
        1,
        makeStep({ strict_spawn: true }),
      );

      expect(capturedTools).not.toContain("delegate");
      expect(capturedRead.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.MAE_SPAWN_DECISION_STRICT;
      else process.env.MAE_SPAWN_DECISION_STRICT = previous;
    }
  });
});
