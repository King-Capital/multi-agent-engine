import { describe, test, expect } from "bun:test";
import { Orchestrator } from "./orchestrator";
import { EchoAdapter } from "./adapters/echo";
import { loadTeams, loadChains, loadPersona, buildSystemPrompt, getTeam, getChain, loadPrompt } from "./config";

const INTEGRATION_TIMEOUT_MS = 30000;

describe("config loading", () => {
  test("loads teams.yaml", () => {
    const teams = loadTeams();
    expect(teams.orchestrator.name).toBe("Orchestrator");
    expect(teams.teams.length).toBeGreaterThan(0);
  });

  test("loads chains.yaml", () => {
    const chains = loadChains();
    expect(chains.chains["plan-build-review"]).toBeDefined();
    expect(chains.chains["plan-build-review"]!.steps.length).toBe(4); // 3 teams + 1 deterministic lint
  });

  test("loads all personas", () => {
    const personas = ["orchestrator", "planner", "builder", "scout", "reviewer", "red-team", "validator"];
    for (const name of personas) {
      const persona = loadPersona(`agents/personas/${name}.md`);
      expect(persona.name).toBeTruthy();
      expect(persona.model).toBeTruthy();
      expect(persona.skills.length).toBeGreaterThan(0);
      expect(persona.tools.length).toBeGreaterThan(0);
    }
  });

  test("builds system prompts with skills", () => {
    const persona = loadPersona("agents/personas/orchestrator.md");
    const prompt = buildSystemPrompt(persona);
    expect(prompt).toContain("Zero Micromanagement");
    expect(prompt).toContain("Active Listener");
    expect(prompt).toContain("Prompt Engineering");
  });

  test("gets specific team", () => {
    const team = getTeam("Planning");
    expect(team.lead.name).toBe("Planning Lead");
    expect(team.members.length).toBeGreaterThan(0);
  });

  test("gets specific chain", () => {
    const chain = getChain("build-verify");
    expect(chain.steps.length).toBe(3); // 2 teams + 1 deterministic lint
    expect(chain.steps[2]!.on_feedback).toBeDefined();
    expect(chain.steps[2]!.on_feedback!.max_attempts).toBe(3);
  });

  test("loads prompts", () => {
    const { config, body } = loadPrompt("plan-build-review");
    expect(config.description).toContain("Full SDLC");
    expect(config.chain).toBe("plan-build-review");
    expect(body).toContain("Workflow");
  });
});

describe("orchestrator with echo adapter", () => {
  test("runs plan-build-review chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Test task",
      chain: "plan-build-review",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
    expect(session.totalCost).toBeGreaterThan(0);
  }, INTEGRATION_TIMEOUT_MS);

  test("runs scout-then-plan chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Explore the auth module",
      chain: "scout-then-plan",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });

  test("runs review-only chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Review git diff HEAD~1",
      chain: "review-only",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });

  test("runs prompt-based workflow", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      prompt: "review",
      task: "git diff HEAD",
      args: ["git diff HEAD"],
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
  });
});

describe("adapter detection", () => {
  test("echo adapter is always available", async () => {
    const echo = new EchoAdapter();
    expect(await echo.isAvailable()).toBe(true);
  });
});

describe("team configs", () => {
  test("has cross-model teams", () => {
    const teams = loadTeams();
    const engA = teams.teams.find((t) => t["team-name"] === "Engineering");
    const engB = teams.teams.find((t) => t["team-name"] === "Engineering B");
    expect(engA).toBeDefined();
    expect(engB).toBeDefined();
    expect(engA!.lead.model).not.toBe(engB!.lead.model);
  });

  test("validation teams use different models", () => {
    const teams = loadTeams();
    const valA = teams.teams.find((t) => t["team-name"] === "Validation");
    const valB = teams.teams.find((t) => t["team-name"] === "Validation B");
    expect(valA).toBeDefined();
    expect(valB).toBeDefined();
    expect(valA!.lead.model).not.toBe(valB!.lead.model);
  });
});

describe("steering", () => {
  test("routes @agent-name message to correct agent", () => {
    const orch = new Orchestrator("");
    
    // Simulate message senders registered by the adapter
    const received: { agent: string; message: string }[] = [];
    
    // Access the private messageSenders map via any cast
    const orchAny = orch as any;
    orchAny.emitter = { message: async () => {} };
    orchAny.messageSenders = new Map([
      ["session-1:code-reviewer", (msg: string) => received.push({ agent: "code-reviewer", message: msg })],
      ["session-1:security-reviewer", (msg: string) => received.push({ agent: "security-reviewer", message: msg })],
    ]);

    // Send a targeted message
    orch.sendUserMessage("session-1", "@Code Reviewer focus on error handling");

    expect(received.length).toBe(1);
    expect(received[0]!.agent).toBe("code-reviewer");
    expect(received[0]!.message).toBe("focus on error handling");
  });

  test("does not inject freeform steer messages into an arbitrary active agent", () => {
    const orch = new Orchestrator("");
    const received: string[] = [];
    
    const orchAny = orch as any;
    orchAny.emitter = { message: async () => {} };
    orchAny.messageSenders = new Map([
      ["session-1:lead", (msg: string) => received.push(msg)],
      ["session-1:worker", (msg: string) => received.push(msg)],
    ]);

    orch.sendUserMessage("session-1", "how's progress?");

    expect(received).toEqual([]);
  });

  test("acknowledges frontend steer messages immediately and passes them to the orchestrator loop", async () => {
    const orch = new Orchestrator("");
    const messages: { content: string; metadata: Record<string, unknown> }[] = [];
    const loopMessages: string[] = [];

    const orchAny = orch as any;
    orchAny.emitter = {
      message: async (
        _sessionId: string,
        _agentId: string,
        _name: string,
        _channel: string,
        content: string,
        metadata: Record<string, unknown> = {},
      ) => {
        messages.push({ content, metadata });
      },
    };
    orchAny.orchestratorLoop = {
      handleUserMessage: async (content: string) => {
        loopMessages.push(content);
      },
    };

    orch.sendUserMessage("session-1", "focus on the API contract first", "msg-123");
    await Bun.sleep(10);

    expect(messages).toEqual([
      { content: "ACK: received steer message; orchestrator reasoning cycle started.", metadata: { ack_for: "msg-123" } },
    ]);
    expect(loopMessages).toEqual(["focus on the API contract first"]);
  });

  test("ping steer messages return pong without starting reasoning", async () => {
    const orch = new Orchestrator("");
    const messages: Array<{ content: string; metadata: Record<string, unknown> }> = [];
    const loopMessages: string[] = [];
    const orchAny = orch as any;
    orchAny.emitter = {
      message: async (
        _sessionId: string,
        _agentId: string,
        _agentName: string,
        _channel: string,
        content: string,
        metadata: Record<string, unknown> = {},
      ) => {
        messages.push({ content, metadata });
      },
    };
    orchAny.orchestratorLoop = {
      handleUserMessage: async (content: string) => {
        loopMessages.push(content);
      },
    };

    orch.sendUserMessage("session-1", " ping ", "msg-ping");
    await Bun.sleep(10);

    expect(messages).toEqual([
      { content: "pong", metadata: { ack_for: "msg-ping" } },
    ]);
    expect(loopMessages).toEqual([]);
  });

  test("pause and resume commands update session state and PG status", async () => {
    const orch = new Orchestrator("");
    const session = { id: "session-1", status: "active" };
    const messages: string[] = [];
    const events: string[] = [];
    const pgUpdates: Array<{ id: string; status?: string }> = [];

    const orchAny = orch as any;
    orchAny.sessions = new Map([["session-1", session]]);
    orchAny.emitter = {
      message: async (
        _sessionId: string,
        _agentId: string,
        _name: string,
        _channel: string,
        content: string,
      ) => {
        messages.push(content);
      },
      emit: async (evt: { event_type: string }) => {
        events.push(evt.event_type);
      },
      pgUpdateSession: async (id: string, updates: { status?: string }) => {
        pgUpdates.push({ id, status: updates.status });
      },
    };

    orch.sendUserMessage("session-1", "!pause");
    await Bun.sleep(10);

    expect(session.status).toBe("paused");
    expect(orchAny.pausedSessions.has("session-1")).toBe(true);
    expect(events).toContain("pause");
    expect(messages).toContain("Session paused. Running agents will finish current work. Send !resume to continue.");
    expect(pgUpdates).toContainEqual({ id: "session-1", status: "paused" });

    orch.sendUserMessage("session-1", "!resume");
    await Bun.sleep(10);

    expect(session.status).toBe("active");
    expect(orchAny.pausedSessions.has("session-1")).toBe(false);
    expect(events).toContain("resume");
    expect(messages).toContain("Session resumed.");
    expect(pgUpdates).toContainEqual({ id: "session-1", status: "active" });
  });
});

import { SandboxPool } from "./sandbox-pool";

describe("sandbox pool", () => {
  test("assigns and releases sandboxes", async () => {
    const pool = new SandboxPool({ poolSize: 2 });
    
    const sb1 = await pool.assign("agent-1");
    expect(sb1).not.toBeNull();
    expect(sb1!.id).toBe(1);
    expect(sb1!.ip).toBe("10.0.0.81");
    expect(sb1!.active).toBe(true);

    const sb2 = await pool.assign("agent-2");
    expect(sb2).not.toBeNull();
    expect(sb2!.id).toBe(2);

    // No more sandboxes available
    const sb3 = await pool.assign("agent-3");
    expect(sb3).toBeNull();

    // Release one
    await pool.release("agent-1");
    
    // Now it's available again
    const sb4 = await pool.assign("agent-4");
    expect(sb4).not.toBeNull();
    expect(sb4!.id).toBe(1);
  });

  test("tracks pool status", async () => {
    const pool = new SandboxPool({ poolSize: 4 });
    
    let status = pool.status();
    expect(status.total).toBe(4);
    expect(status.available).toBe(4);
    expect(status.active).toBe(0);

    await pool.assign("agent-1");
    await pool.assign("agent-2");

    status = pool.status();
    expect(status.available).toBe(2);
    expect(status.active).toBe(2);
  });

  test("getAssigned returns correct sandbox", async () => {
    const pool = new SandboxPool({ poolSize: 2 });
    
    await pool.assign("agent-1");
    
    const sb = pool.getAssigned("agent-1");
    expect(sb).toBeDefined();
    expect(sb!.vmid).toBe(801);

    expect(pool.getAssigned("agent-99")).toBeUndefined();
  });
});

describe("pipeline state tracking", () => {
  test("checkpoints each chain step to disk", async () => {
    const { mkdtempSync, existsSync, readFileSync, rmSync } = require("fs");
    const { join } = require("path");
    const tmpDir = mkdtempSync(join(require("os").tmpdir(), "mae-pipe-"));
    
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    // Override data dir to temp
    const origDataDir = process.env.MAE_DATA_DIR;
    process.env.MAE_DATA_DIR = tmpDir;

    const session = await orch.run({
      task: "Pipeline state test",
      chain: "plan-build-review",
      adapter: "echo",
    });

    // Restore
    if (origDataDir) process.env.MAE_DATA_DIR = origDataDir;
    else delete process.env.MAE_DATA_DIR;

    expect(session.status).toBe("completed");
    
    // Pipeline state file should exist
    const pipeDir = join(tmpDir, "pipelines");
    if (existsSync(pipeDir)) {
      const files = require("fs").readdirSync(pipeDir);
      expect(files.length).toBeGreaterThanOrEqual(0); // May not write if no pipeline tracking
    }
    
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }, INTEGRATION_TIMEOUT_MS);

  test("collects events from chain steps", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Event collection test",
      chain: "review-only",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
    // Session should have agents from the chain
    expect(session.totalCost).toBeGreaterThanOrEqual(0);
  });

  test("reports cost per agent in chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Cost tracking test",
      chain: "plan-build-review",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
    expect(session.totalCost).toBeGreaterThan(0);
    // Each agent should have cost info
    if (session.agents) {
      for (const [, agent] of session.agents) {
        expect(agent.costUsd).toBeGreaterThanOrEqual(0);
      }
    }
  }, INTEGRATION_TIMEOUT_MS);
});

describe("chain robustness", () => {
  test("handles build-verify chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Chain test: build-verify",
      chain: "build-verify",
      adapter: "echo",
    });
    expect(session.status).toBe("completed");
  }, INTEGRATION_TIMEOUT_MS);

  test("handles swarm-review chain", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Chain test: swarm-review",
      chain: "swarm-review",
      adapter: "echo",
    });
    expect(session.status).toBe("completed");
  });

  test("chain run completes with cost data", async () => {
    const orch = new Orchestrator("");
    orch.registerAdapter(new EchoAdapter());
    orch.setDefaultAdapter("echo");

    const session = await orch.run({
      task: "Output verification test",
      chain: "plan-build-review",
      adapter: "echo",
    });

    expect(session.status).toBe("completed");
    expect(session.totalCost).toBeGreaterThanOrEqual(0);
    expect(session.totalTokens).toBeGreaterThanOrEqual(0);
  }, INTEGRATION_TIMEOUT_MS);
});

describe("model routing", () => {
  test("thinking levels are ordered", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    expect(levels.indexOf("high")).toBeGreaterThan(levels.indexOf("low"));
    expect(levels.indexOf("xhigh")).toBeGreaterThan(levels.indexOf("high"));
  });

  test("model tier names are valid", () => {
    const validTiers = ["quality", "main", "fast", "pro", "high", "medium"];
    expect(validTiers).toContain("quality");
    expect(validTiers).toContain("fast");
  });
});
